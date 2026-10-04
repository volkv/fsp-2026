// What a code task attempt keeps of a run (docs/domain.md, section 10.4; docs/contracts.md, section 6.4): the
// submitted code before the call, then one `run_result` for the compile step and one per test after it. These are
// the `kind`, `content` and `sha256` of `assessment_artifacts` rows; the job adds attempt, order and retention.
import { canonicalJson } from '../json/canonical';
import { sha256 } from './text';
import type { RunRequest, RunResponse } from './types';

export interface ArtifactDraft {
	kind: 'code_submission' | 'run_result';
	content: Record<string, unknown>;
	/** SHA-256 of the canonical JSON of `content`: stays valid after `content` is read back from jsonb. */
	sha256: string;
}

function draft(kind: ArtifactDraft['kind'], content: Record<string, unknown>): ArtifactDraft {
	return { kind, content, sha256: sha256(canonicalJson(content)) };
}

/** Saved before the sandbox is called: the code the attempt is judged by. */
export function codeSubmissionArtifact(request: Pick<RunRequest, 'requestId' | 'language' | 'source'>): ArtifactDraft {
	return draft('code_submission', {
		request_id: request.requestId,
		language: request.language,
		source: request.source,
		source_sha256: sha256(request.source),
		source_bytes: Buffer.byteLength(request.source, 'utf8')
	});
}

/**
 * Saved after the answer, in this order: the compile step (when the language has one), then every test. A hidden
 * test keeps its verdict, measurements and output hash; its output never had a preview.
 */
export function runResultArtifacts(response: RunResponse, tests: RunRequest['tests']): ArtifactDraft[] {
	const hidden = new Map(tests.map((test) => [test.id, test.hidden]));
	const common = {
		request_id: response.requestId,
		engine: { name: response.engine.name, version: response.engine.version },
		language: { key: response.language.key, version: response.language.version }
	};
	const drafts: ArtifactDraft[] = [];
	if (response.compile) {
		drafts.push(
			draft('run_result', {
				...common,
				stage: 'compile',
				status: response.compile.status,
				stderr: response.compile.stderr
			})
		);
	}
	for (const test of response.tests) {
		const isHidden = hidden.get(test.id);
		if (isHidden === undefined) throw new Error(`test ${test.id} of the response is not in the request`);
		drafts.push(
			draft('run_result', {
				...common,
				stage: 'test',
				test_id: test.id,
				hidden: isHidden,
				verdict: test.verdict,
				skipped: test.skipped === true,
				cpu_time_ms: test.cpuTimeMs,
				wall_time_ms: test.wallTimeMs,
				memory_kb: test.memoryKb,
				exit_code: test.exitCode,
				signal: test.signal,
				stdout_sha256: test.stdoutSha256,
				stdout_preview: isHidden ? null : test.stdoutPreview
			})
		);
	}
	return drafts;
}
