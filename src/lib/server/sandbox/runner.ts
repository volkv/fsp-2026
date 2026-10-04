// SandboxRunner over go-judge (docs/contracts.md, section 6). One run: an optional compile step, then every test in
// order, each in a fresh environment with its own limits. The adapter compares outputs itself and maps go-judge
// statuses onto the contract verdicts; a failure of the sandbox never turns into a verdict against the candidate.
import { constants } from 'node:os';
import { outputMatches } from './checker';
import { GoJudgeClient, type GoJudgeCommand, type GoJudgeFile, type GoJudgeResult } from './go-judge';
import {
	LANGUAGES_PATH,
	languageFileSchema,
	languageSpec,
	languagesOf,
	runArgs,
	stepEnv,
	type SandboxLanguage
} from './languages';
import { describeIssues, runRequestSchema } from './request';
import { sha256, truncateUtf8 } from './text';
import type {
	CompileStatus,
	LanguageSpec,
	RunRequest,
	RunResponse,
	SandboxError,
	SandboxErrorCode,
	SandboxResult,
	SandboxRunner,
	SandboxTest,
	TestResult,
	Verdict
} from './types';

export interface GoJudgeRunnerOptions {
	/** go-judge through its gateway: `http://sandbox-gateway:8080` in compose, `http://localhost:57950` from the host. */
	baseUrl: string;
	/** Runs this process sends at once; one more is `busy` (docs/contracts.md, section 6.2). */
	maxConcurrentRuns: number;
}

const ENGINE_NAME = 'go-judge';
/** The whole request, compile step and tests (docs/contracts.md, section 6.2). */
const REQUEST_BUDGET_MS = 60_000;
/** On top of a program's own wall limit: queueing in go-judge, building the environment, copying files. */
const TRANSPORT_MARGIN_MS = 10_000;
/** Reading the language set, the engine version, removing a compiled program. */
const SERVICE_TIMEOUT_MS = 5_000;
/** How long the language set and the engine version are trusted before they are read again. */
const CATALOG_TTL_MS = 60_000;
const COMPILE_STDERR_BYTES = 4 * 1024;
/** The compiler may print a lot before failing; only the first 4 KB are kept, but it must not be killed for it. */
const COMPILE_OUTPUT_MAX_BYTES = 1024 * 1024;
const PREVIEW_BYTES = 1024;
const MB = 1024 * 1024;

interface Catalog {
	engineVersion: string;
	languages: SandboxLanguage[];
	expiresAt: number;
}

type Failure<C extends SandboxErrorCode> = { ok: false; error: SandboxError<C> };

const RETRYABLE: Record<SandboxErrorCode, boolean> = {
	unavailable: true,
	busy: true,
	internal: true,
	invalid_request: false,
	unsupported_language: false
};

function fail<C extends SandboxErrorCode>(code: C, message: string, details?: Record<string, unknown>): Failure<C> {
	return { ok: false, error: { code, retryable: RETRYABLE[code], message, ...(details ? { details } : {}) } };
}

const SIGNAL_NAMES = new Map<number, string>(
	Object.entries(constants.signals).map(([name, number]) => [number, name] as const)
);

const EMPTY_SHA256 = sha256('');

function notRun(test: SandboxTest, verdict: Verdict, skipped: boolean): TestResult {
	return {
		id: test.id,
		verdict,
		cpuTimeMs: 0,
		wallTimeMs: 0,
		memoryKb: 0,
		exitCode: null,
		signal: null,
		stdoutSha256: EMPTY_SHA256,
		stdoutPreview: null,
		...(skipped ? { skipped: true as const } : {})
	};
}

function outputOverflowed(result: GoJudgeResult): boolean {
	return (result.fileError ?? []).some((error) => error.type === 'CollectSizeExceeded');
}

/** go-judge status → contract verdict; `Accepted` still needs the output check (docs/contracts.md, section 6.2). */
function programVerdict(result: GoJudgeResult): Verdict | 'check_output' {
	if (outputOverflowed(result)) return 'output_limit';
	switch (result.status) {
		case 'Accepted':
			return 'check_output';
		case 'Time Limit Exceeded':
			return 'time_limit';
		case 'Memory Limit Exceeded':
			return 'memory_limit';
		case 'Output Limit Exceeded':
			return 'output_limit';
		case 'Nonzero Exit Status':
		case 'Signalled':
		case 'Dangerous Syscall':
			return 'runtime_error';
		case 'File Error':
		case 'Internal Error':
			return 'sandbox_error';
	}
}

function compileStatus(result: GoJudgeResult): CompileStatus | 'engine_failure' {
	switch (result.status) {
		case 'Accepted':
			return outputOverflowed(result) ? 'compile_error' : 'ok';
		case 'Time Limit Exceeded':
			return 'time_limit';
		case 'Memory Limit Exceeded':
			return 'memory_limit';
		case 'Output Limit Exceeded':
		case 'Nonzero Exit Status':
		case 'Signalled':
		case 'Dangerous Syscall':
			return 'compile_error';
		case 'File Error':
		case 'Internal Error':
			return 'engine_failure';
	}
}

function exitOf(result: GoJudgeResult): { exitCode: number | null; signal: string | null } {
	switch (result.status) {
		case 'Accepted':
		case 'Nonzero Exit Status':
			return { exitCode: result.exitStatus, signal: null };
		case 'Signalled':
			return { exitCode: null, signal: SIGNAL_NAMES.get(result.exitStatus) ?? `SIG${result.exitStatus}` };
		default:
			return { exitCode: null, signal: null };
	}
}

export class GoJudgeRunner implements SandboxRunner {
	readonly contractVersion = 'v1' as const;
	readonly #client: GoJudgeClient;
	readonly #maxConcurrentRuns: number;
	#inFlight = 0;
	#catalog: Catalog | null = null;

	constructor(options: GoJudgeRunnerOptions) {
		if (!Number.isInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns < 1) {
			throw new RangeError('maxConcurrentRuns must be a positive integer');
		}
		this.#client = new GoJudgeClient(options.baseUrl);
		this.#maxConcurrentRuns = options.maxConcurrentRuns;
	}

	async languages(): Promise<SandboxResult<LanguageSpec[], 'unavailable'>> {
		const catalog = await this.#loadCatalog();
		if (!catalog.ok) return catalog;
		return { ok: true, value: catalog.value.languages.map(languageSpec) };
	}

	async run(request: RunRequest): Promise<SandboxResult<RunResponse, SandboxErrorCode>> {
		const parsed = runRequestSchema.safeParse(request);
		if (!parsed.success) {
			return fail('invalid_request', 'sandbox: run request is invalid', { issues: describeIssues(parsed.error) });
		}
		if (this.#inFlight >= this.#maxConcurrentRuns) {
			return fail('busy', `sandbox: ${this.#maxConcurrentRuns} runs already in progress`);
		}
		this.#inFlight++;
		try {
			return await this.#execute(parsed.data, Date.now() + REQUEST_BUDGET_MS);
		} finally {
			this.#inFlight--;
		}
	}

	async #execute(request: RunRequest, deadline: number): Promise<SandboxResult<RunResponse, SandboxErrorCode>> {
		const catalog = await this.#loadCatalog();
		if (!catalog.ok) return catalog;
		const language = catalog.value.languages.find((candidate) => candidate.key === request.language);
		if (!language) {
			return fail('unsupported_language', `sandbox: language ${request.language} is not in the image`, {
				available: catalog.value.languages.map((candidate) => candidate.key)
			});
		}
		const header = {
			requestId: request.requestId,
			engine: { name: ENGINE_NAME, version: catalog.value.engineVersion },
			language: { key: language.key, version: language.version }
		};

		const stored: string[] = [];
		try {
			let programFiles: Record<string, GoJudgeFile> = { [language.sourceFile]: { content: request.source } };
			let compile: RunResponse['compile'] = null;
			if (language.compile) {
				const compiled = await this.#compile(language, request, stored);
				if (!compiled.ok) return compiled;
				compile = compiled.value.compile;
				if (compile.status !== 'ok') {
					return {
						ok: true,
						value: { ...header, compile, tests: request.tests.map((test) => notRun(test, 'compile_error', false)) }
					};
				}
				if (language.artifacts.length > 0) programFiles = compiled.value.artifacts;
			}

			const tests: TestResult[] = [];
			for (const test of request.tests) {
				// A test is started only if its wall limit still fits into the request budget.
				if (deadline - Date.now() < request.limits.wallTimeMs) {
					tests.push(notRun(test, 'time_limit', true));
					continue;
				}
				const result = await this.#runTest(language, request, test, programFiles);
				if (!result.ok) return result;
				tests.push(result.value);
			}
			return { ok: true, value: { ...header, compile, tests } };
		} finally {
			await this.#forget(stored);
		}
	}

	async #compile(
		language: SandboxLanguage,
		request: RunRequest,
		stored: string[]
	): Promise<
		SandboxResult<
			{ compile: NonNullable<RunResponse['compile']>; artifacts: Record<string, GoJudgeFile> },
			'unavailable' | 'internal'
		>
	> {
		const step = language.compile;
		if (!step) throw new Error(`language ${language.key} has no compile step`);
		const { limits } = request;
		const command: GoJudgeCommand = {
			args: step.args,
			env: stepEnv(language, 'compile'),
			stdin: '',
			outputMaxBytes: COMPILE_OUTPUT_MAX_BYTES,
			cpuLimitMs: limits.compileCpuTimeMs,
			// Compilers are mostly single-threaded; the wall limit only stops one that waits instead of working.
			clockLimitMs: 2 * limits.compileCpuTimeMs,
			memoryLimitBytes: limits.compileMemoryMb * MB,
			procLimit: step.tasks,
			copyIn: { [language.sourceFile]: { content: request.source } },
			copyOutCached: language.artifacts
		};
		const response = await this.#client.run(command, AbortSignal.timeout(command.clockLimitMs + TRANSPORT_MARGIN_MS));
		if (!response.ok) return response;
		const result = response.value;
		stored.push(...Object.values(result.fileIds ?? {}));

		const status = compileStatus(result);
		if (status === 'engine_failure') {
			return fail('internal', 'sandbox: the engine failed to run the compiler', {
				status: result.status,
				reason: result.error
			});
		}
		const compile = { status, stderr: truncateUtf8(result.files?.stderr ?? '', COMPILE_STDERR_BYTES) };
		if (status !== 'ok') return { ok: true, value: { compile, artifacts: {} } };

		const artifacts: Record<string, GoJudgeFile> = {};
		for (const name of language.artifacts) {
			const fileId = result.fileIds?.[name];
			if (fileId === undefined) {
				return fail('internal', `sandbox: the compiler of ${language.key} left no ${name}`);
			}
			artifacts[name] = { fileId };
		}
		return { ok: true, value: { compile, artifacts } };
	}

	async #runTest(
		language: SandboxLanguage,
		request: RunRequest,
		test: SandboxTest,
		programFiles: Record<string, GoJudgeFile>
	): Promise<SandboxResult<TestResult, 'unavailable'>> {
		const { limits } = request;
		const command: GoJudgeCommand = {
			args: runArgs(language, limits.memoryMb),
			env: stepEnv(language, 'run'),
			stdin: test.stdin,
			outputMaxBytes: limits.outputKb * 1024,
			cpuLimitMs: limits.cpuTimeMs,
			clockLimitMs: limits.wallTimeMs,
			memoryLimitBytes: limits.memoryMb * MB,
			// The runtime's own threads plus the processes the task allows beyond the program itself.
			procLimit: language.run.tasks + limits.processes - 1,
			copyIn: programFiles,
			copyOutCached: []
		};
		const response = await this.#client.run(command, AbortSignal.timeout(limits.wallTimeMs + TRANSPORT_MARGIN_MS));
		if (!response.ok) {
			if (response.error.code === 'unavailable')
				return fail('unavailable', response.error.message, response.error.details);
			// The engine is up but could not run this test: the test is not judged, the run is retried as a whole.
			console.error('[sandbox] engine failed on a test', response.error);
			return { ok: true, value: notRun(test, 'sandbox_error', false) };
		}
		const result = response.value;
		const stdout = result.files?.stdout ?? '';
		const verdict = programVerdict(result);
		if (verdict === 'sandbox_error')
			console.error('[sandbox] engine failed on a test', { status: result.status, reason: result.error });
		return {
			ok: true,
			value: {
				id: test.id,
				verdict:
					verdict === 'check_output'
						? outputMatches(request.checker, stdout, test.expected)
							? 'accepted'
							: 'wrong_answer'
						: verdict,
				cpuTimeMs: Math.round(result.time / 1e6),
				wallTimeMs: Math.round(result.runTime / 1e6),
				memoryKb: Math.round(result.memory / 1024),
				...exitOf(result),
				stdoutSha256: sha256(stdout),
				stdoutPreview: test.hidden ? null : truncateUtf8(stdout, PREVIEW_BYTES)
			}
		};
	}

	async #loadCatalog(): Promise<SandboxResult<Catalog, 'unavailable'>> {
		if (this.#catalog && this.#catalog.expiresAt > Date.now()) return { ok: true, value: this.#catalog };
		const signal = AbortSignal.timeout(SERVICE_TIMEOUT_MS);
		const version = await this.#client.version(signal);
		if (!version.ok) return fail('unavailable', version.error.message, version.error.details);
		const read = await this.#client.run(
			{
				args: ['/bin/cat', LANGUAGES_PATH],
				env: [],
				stdin: '',
				outputMaxBytes: MB,
				cpuLimitMs: 1_000,
				clockLimitMs: 3_000,
				memoryLimitBytes: 64 * MB,
				procLimit: 1,
				copyIn: {},
				copyOutCached: []
			},
			signal
		);
		if (!read.ok) return fail('unavailable', read.error.message, read.error.details);
		if (read.value.status !== 'Accepted') {
			return fail('unavailable', 'sandbox: the language set of the image is unreadable', {
				status: read.value.status
			});
		}
		let file: unknown;
		try {
			file = JSON.parse(read.value.files?.stdout ?? '');
		} catch {
			return fail('unavailable', 'sandbox: the language set of the image is not JSON');
		}
		const parsed = languageFileSchema.safeParse(file);
		if (!parsed.success) {
			return fail('unavailable', 'sandbox: the language set of the image is invalid', {
				issues: describeIssues(parsed.error)
			});
		}
		this.#catalog = {
			engineVersion: version.value,
			languages: languagesOf(parsed.data),
			expiresAt: Date.now() + CATALOG_TTL_MS
		};
		return { ok: true, value: this.#catalog };
	}

	/** Compiled programs are removed right away; one that cannot be removed now expires in go-judge on its own. */
	async #forget(fileIds: string[]): Promise<void> {
		for (const fileId of fileIds) {
			const removed = await this.#client.deleteFile(fileId, AbortSignal.timeout(SERVICE_TIMEOUT_MS));
			if (!removed.ok) console.error('[sandbox] compiled program left in the engine store', removed.error);
		}
	}
}
