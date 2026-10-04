// HTTP client of go-judge (https://docs.goj.ac/api): one command per request, the result validated before use.
// Transport failures become `unavailable`, anything go-judge refuses becomes `internal`; no retries here.
import { z } from 'zod';
import type { SandboxError } from './types';

/** Program status names of go-judge (`envexec.Status`). */
export const GO_JUDGE_STATUSES = [
	'Accepted',
	'Memory Limit Exceeded',
	'Time Limit Exceeded',
	'Output Limit Exceeded',
	'File Error',
	'Nonzero Exit Status',
	'Signalled',
	'Dangerous Syscall',
	'Internal Error'
] as const;

const resultSchema = z.object({
	status: z.enum(GO_JUDGE_STATUSES),
	exitStatus: z.number().int(),
	error: z.string().optional(),
	/** CPU time, ns. */
	time: z.number().nonnegative(),
	/** Peak memory, bytes. */
	memory: z.number().nonnegative(),
	/** Wall time, ns. */
	runTime: z.number().nonnegative(),
	files: z.record(z.string(), z.string()).optional(),
	fileIds: z.record(z.string(), z.string()).optional(),
	fileError: z.array(z.object({ name: z.string(), type: z.string(), message: z.string().optional() })).optional()
});

export type GoJudgeResult = z.infer<typeof resultSchema>;

const versionSchema = z.object({ buildVersion: z.string().min(1) });

export type GoJudgeFile = { content: string } | { fileId: string };

export interface GoJudgeCommand {
	args: string[];
	env: string[];
	stdin: string;
	/** Largest stdout and stderr go-judge collects; more is `CollectSizeExceeded`. */
	outputMaxBytes: number;
	cpuLimitMs: number;
	clockLimitMs: number;
	memoryLimitBytes: number;
	procLimit: number;
	copyIn: Record<string, GoJudgeFile>;
	/** Files kept in go-judge's store after the run and returned as `fileIds`. */
	copyOutCached: string[];
}

type Failure = { ok: false; error: SandboxError<'unavailable' | 'internal'> };

function failure(code: 'unavailable' | 'internal', message: string, details?: Record<string, unknown>): Failure {
	return { ok: false, error: { code, retryable: true, message, ...(details ? { details } : {}) } };
}

const MS = 1_000_000;

export class GoJudgeClient {
	readonly #baseUrl: string;

	constructor(baseUrl: string) {
		this.#baseUrl = baseUrl.replace(/\/+$/, '');
	}

	async run(command: GoJudgeCommand, signal: AbortSignal): Promise<{ ok: true; value: GoJudgeResult } | Failure> {
		const body = {
			cmd: [
				{
					args: command.args,
					env: command.env,
					files: [
						{ content: command.stdin },
						{ name: 'stdout', max: command.outputMaxBytes },
						{ name: 'stderr', max: command.outputMaxBytes }
					],
					cpuLimit: command.cpuLimitMs * MS,
					clockLimit: command.clockLimitMs * MS,
					memoryLimit: command.memoryLimitBytes,
					// Deep recursion is the program's business as long as it stays within its memory.
					stackLimit: command.memoryLimitBytes,
					procLimit: command.procLimit,
					copyIn: command.copyIn,
					copyOutCached: command.copyOutCached
				}
			]
		};
		const response = await this.#request('/run', { method: 'POST', body: JSON.stringify(body), signal });
		if (!response.ok) return response;
		const parsed = z.array(resultSchema).length(1).safeParse(response.value);
		if (!parsed.success) return failure('internal', 'sandbox: unexpected response of the engine');
		const [result] = parsed.data as [GoJudgeResult];
		return { ok: true, value: result };
	}

	async version(signal: AbortSignal): Promise<{ ok: true; value: string } | Failure> {
		const response = await this.#request('/version', { method: 'GET', signal });
		if (!response.ok) return response;
		const parsed = versionSchema.safeParse(response.value);
		if (!parsed.success) return failure('internal', 'sandbox: unexpected version response of the engine');
		return { ok: true, value: parsed.data.buildVersion.replace(/^v/, '') };
	}

	/** Removes a compiled program from go-judge's store; go-judge also expires it on its own (`-file-timeout`). */
	async deleteFile(fileId: string, signal: AbortSignal): Promise<{ ok: true; value: null } | Failure> {
		const response = await this.#request(`/file/${encodeURIComponent(fileId)}`, { method: 'DELETE', signal });
		return response.ok ? { ok: true, value: null } : response;
	}

	async #request(
		path: string,
		init: { method: 'GET' | 'POST' | 'DELETE'; body?: string; signal: AbortSignal }
	): Promise<{ ok: true; value: unknown } | Failure> {
		let response: Response;
		try {
			response = await fetch(`${this.#baseUrl}${path}`, {
				method: init.method,
				headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
				body: init.body,
				signal: init.signal,
				redirect: 'error'
			});
		} catch (error) {
			if (init.signal.aborted) return failure('unavailable', 'sandbox: no answer in time');
			return failure('unavailable', 'sandbox: engine unreachable', { cause: transportCause(error) });
		}
		let text: string;
		try {
			text = await response.text();
		} catch {
			return failure('unavailable', 'sandbox: connection dropped while reading the answer');
		}
		if (response.status === 502 || response.status === 503 || response.status === 504) {
			return failure('unavailable', `sandbox: engine answered ${response.status}`, { status: response.status });
		}
		if (!response.ok) {
			// go-judge puts its error message into the body as a JSON string; it names paths and limits, not data.
			return failure('internal', `sandbox: engine refused the request with ${response.status}`, {
				status: response.status,
				reason: text.slice(0, 300)
			});
		}
		if (text === '') return { ok: true, value: null };
		try {
			return { ok: true, value: JSON.parse(text) as unknown };
		} catch {
			return failure('internal', 'sandbox: engine answer is not JSON');
		}
	}
}

function transportCause(error: unknown): string {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		const code = (current as Error & { code?: unknown }).code;
		if (typeof code === 'string') return code;
		current = current.cause;
	}
	return error instanceof Error ? error.name : 'unknown';
}
