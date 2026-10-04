// Contract of the code execution sandbox (docs/contracts.md, section 6): what the rest of the application sees.
// The engine behind it (go-judge today) is an implementation detail of the adapter.

export type SandboxErrorCode = 'unavailable' | 'busy' | 'invalid_request' | 'unsupported_language' | 'internal';

export interface SandboxError<C extends SandboxErrorCode = SandboxErrorCode> {
	code: C;
	retryable: boolean;
	/** Never contains the submitted code, test data or program output. */
	message: string;
	details?: Record<string, unknown>;
}

export type SandboxResult<T, C extends SandboxErrorCode> =
	{ ok: true; value: T } | { ok: false; error: SandboxError<C> };

export interface LanguageSpec {
	/** `python3`, `javascript`, `typescript`, `go`, `cpp17`, `java21`; the set comes from the sandbox image. */
	key: string;
	/** Version of the compiler or interpreter in the image. */
	version: string;
	sourceFile: string;
	compile: string[] | null;
	run: string[];
}

export interface SandboxTest {
	id: string;
	stdin: string;
	expected: string;
	hidden: boolean;
}

export interface RunLimits {
	cpuTimeMs: number;
	wallTimeMs: number;
	memoryMb: number;
	outputKb: number;
	/** Processes the program may have at once, itself included; the runtime's own threads come on top. */
	processes: number;
	compileCpuTimeMs: number;
	compileMemoryMb: number;
}

export type CheckerSpec = { kind: 'exact' } | { kind: 'tokens' } | { kind: 'float_eps'; eps: number };

export interface RunRequest {
	/** `assessment_artifacts.id` of the code submission: the idempotency key of the run. */
	requestId: string;
	language: string;
	source: string;
	tests: SandboxTest[];
	limits: RunLimits;
	checker: CheckerSpec;
}

export type Verdict =
	| 'accepted'
	| 'wrong_answer'
	| 'time_limit'
	| 'memory_limit'
	| 'output_limit'
	| 'runtime_error'
	| 'compile_error'
	| 'sandbox_error';

export type CompileStatus = 'ok' | 'compile_error' | 'time_limit' | 'memory_limit';

export interface TestResult {
	id: string;
	verdict: Verdict;
	cpuTimeMs: number;
	wallTimeMs: number;
	memoryKb: number;
	exitCode: number | null;
	signal: string | null;
	stdoutSha256: string;
	/** At most 1 KB, and only for tests that are not hidden. */
	stdoutPreview: string | null;
	/**
	 * The test was not started: the request ran out of its time budget on the tests before it. Such a test counts
	 * as `time_limit` of the program, since its own tests used the time up.
	 */
	skipped?: true;
}

export interface RunResponse {
	requestId: string;
	engine: { name: string; version: string };
	language: { key: string; version: string };
	/** At most 4 KB of stderr. `null` for languages without a compile step. */
	compile: { status: CompileStatus; stderr: string } | null;
	tests: TestResult[];
}

export interface SandboxRunner {
	readonly contractVersion: 'v1';
	languages(): Promise<SandboxResult<LanguageSpec[], 'unavailable'>>;
	run(request: RunRequest): Promise<SandboxResult<RunResponse, SandboxErrorCode>>;
}
