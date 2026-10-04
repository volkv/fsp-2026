import { describe, expect, it } from 'vitest';
import { codeSubmissionArtifact, runResultArtifacts } from './artifacts';
import type { RunRequest, RunResponse } from './types';

const tests: RunRequest['tests'] = [
	{ id: 'sample', stdin: '1 2\n', expected: '3\n', hidden: false },
	{ id: 'hidden-1', stdin: '5 7\n', expected: '12\n', hidden: true }
];

const response: RunResponse = {
	requestId: '0199a0b1-7c3e-7000-8000-000000000001',
	engine: { name: 'go-judge', version: '1.12.3' },
	language: { key: 'cpp17', version: '14.2.0' },
	compile: { status: 'ok', stderr: '' },
	tests: [
		{
			id: 'sample',
			verdict: 'accepted',
			cpuTimeMs: 3,
			wallTimeMs: 5,
			memoryKb: 3412,
			exitCode: 0,
			signal: null,
			stdoutSha256: 'a'.repeat(64),
			stdoutPreview: '3\n'
		},
		{
			id: 'hidden-1',
			verdict: 'time_limit',
			cpuTimeMs: 0,
			wallTimeMs: 0,
			memoryKb: 0,
			exitCode: null,
			signal: null,
			stdoutSha256: 'b'.repeat(64),
			stdoutPreview: 'must not be kept',
			skipped: true
		}
	]
};

describe('assessment artifacts of a run', () => {
	it('hashes the code submission before the call', () => {
		const artifact = codeSubmissionArtifact({
			requestId: response.requestId,
			language: 'cpp17',
			source: 'int main() { return 0; }\n'
		});
		expect(artifact.kind).toBe('code_submission');
		expect(artifact.content).toMatchObject({ source_bytes: 25 });
		expect(artifact.sha256).toBe('826fc3fa25af557747b7bf5c0c8ef0ee7e9c97b55faac315b81d3eadf989c365');
	});

	it('hashes the compile step and every test, without the preview of a hidden test', () => {
		const artifacts = runResultArtifacts(response, tests);
		expect(artifacts.map((artifact) => artifact.content.stage ?? null)).toEqual(['compile', 'test', 'test']);
		expect(artifacts[2]?.content).toMatchObject({ hidden: true, skipped: true, stdout_preview: null });
		// Stored hashes of attempts already judged: the canonical form must never change under them.
		expect(artifacts.map((artifact) => artifact.sha256)).toEqual([
			'd8c3b4f63dd696603ac4ed3ac35c52656fffe7c0a00ddf91267bc61bfc64c61d',
			'd0c10afbb2ca6aac02d0a9bceae67c185201ca592c0aab4abb2d7ccecddcfbc4',
			'c5b029af6fde79d957b248daa535b69d5622cadc333912f3b7eb3ddf50a04d93'
		]);
	});
});
