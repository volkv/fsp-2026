// The sandbox adapter against the real sandbox image: verdicts in every language, limits, and the isolation of the
// program (network, file system, processes). The container gets the privileges of compose.yaml and nothing more.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessmentArtifacts, assessmentAttempts, assessments, assessmentVersions } from '$lib/server/db/schema';
import { codeSubmissionArtifact, runResultArtifacts } from '$lib/server/sandbox/artifacts';
import { GoJudgeRunner } from '$lib/server/sandbox/runner';
import type { RunLimits, RunRequest, RunResponse, SandboxTest } from '$lib/server/sandbox/types';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate } from '../helpers/factories';

const SANDBOX_DIR = fileURLToPath(new URL('../../services/sandbox', import.meta.url));
const IMAGE = 'fsp-sandbox:test';
const GO_JUDGE_PORT = 5050;

/** The sandbox service of compose.yaml, option for option. */
class SandboxContainer extends GenericContainer {
	constructor() {
		super(IMAGE);
		this.withExposedPorts(GO_JUDGE_PORT)
			.withDroppedCapabilities('ALL')
			.withAddedCapabilities('SYS_ADMIN', 'SETUID', 'SETGID', 'SETFCAP')
			.withSecurityOpt(
				'no-new-privileges:true',
				`seccomp=${readFileSync(`${SANDBOX_DIR}/seccomp.json`, 'utf8')}`,
				'apparmor=unconfined'
			)
			.withTmpFs({ '/tmp': 'size=64m', '/run': 'size=1m' })
			.withSharedMemorySize(128 * 1024 * 1024)
			.withResourcesQuota({ memory: 1.5, cpu: 2 })
			.withWaitStrategy(Wait.forHealthCheck())
			.withStartupTimeout(60_000);
		// The Docker API has CgroupnsMode; the dockerode typings behind testcontainers lack it.
		const hostConfig: typeof this.hostConfig & { CgroupnsMode?: 'private' | 'host' } = this.hostConfig;
		hostConfig.ReadonlyRootfs = true;
		hostConfig.PidsLimit = 512;
		hostConfig.CgroupnsMode = 'private';
		hostConfig.MemorySwap = 1536 * 1024 * 1024;
	}
}

const LIMITS: RunLimits = {
	cpuTimeMs: 2_000,
	wallTimeMs: 5_000,
	memoryMb: 256,
	outputKb: 64,
	processes: 1,
	compileCpuTimeMs: 10_000,
	compileMemoryMb: 512
};

const SUM_TESTS: SandboxTest[] = [
	{ id: 'open', stdin: '1 2\n', expected: '3\n', hidden: false },
	{ id: 'hidden', stdin: '1000000000000 7\n', expected: '1000000000007', hidden: true }
];

const SUM_SOURCES: Record<string, string> = {
	python3: 'a, b = map(int, input().split())\nprint(a + b)\n',
	javascript:
		"const [a, b] = require('node:fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(BigInt);\nconsole.log(String(a + b));\n",
	typescript:
		"import { readFileSync } from 'node:fs';\nconst [a, b]: bigint[] = readFileSync(0, 'utf8').trim().split(/\\s+/).map(BigInt);\nconsole.log(String(a + b));\n",
	go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar a, b int64\n\tfmt.Scan(&a, &b)\n\tfmt.Println(a + b)\n}\n',
	cpp17:
		'#include <iostream>\nint main() {\n\tlong long a, b;\n\tstd::cin >> a >> b;\n\tstd::cout << a + b << "\\n";\n}\n',
	java21:
		'import java.util.Scanner;\n\npublic class Main {\n\tpublic static void main(String[] args) {\n\t\tScanner in = new Scanner(System.in);\n\t\tSystem.out.println(in.nextLong() + in.nextLong());\n\t}\n}\n'
};

let container: StartedTestContainer;
let runner: GoJudgeRunner;
let sequence = 0;

function request(language: string, source: string, overrides: Partial<RunRequest> = {}): RunRequest {
	sequence++;
	return {
		requestId: `request-${sequence}`,
		language,
		source,
		tests: [{ id: 't1', stdin: '', expected: '', hidden: false }],
		limits: LIMITS,
		checker: { kind: 'exact' },
		...overrides
	};
}

async function run(runRequest: RunRequest): Promise<RunResponse> {
	const result = await runner.run(runRequest);
	if (!result.ok) throw new Error(`run failed: ${JSON.stringify(result.error)}`);
	return result.value;
}

/** Runs a Python program on one open test with an empty input and returns that test's result. */
async function runPython(source: string, options: { limits?: Partial<RunLimits>; expected?: string } = {}) {
	const response = await run(
		request('python3', source, {
			tests: [{ id: 't1', stdin: '', expected: options.expected ?? '', hidden: false }],
			limits: { ...LIMITS, ...options.limits }
		})
	);
	const [test] = response.tests;
	if (!test) throw new Error('no test result');
	return test;
}

beforeAll(async () => {
	// The Docker CLI shares the build cache with `docker compose build`; the first build pulls the toolchain images.
	await promisify(execFile)('docker', ['build', '--quiet', '--tag', IMAGE, SANDBOX_DIR], {
		maxBuffer: 16 * 1024 * 1024
	});
	container = await new SandboxContainer().start();
	runner = new GoJudgeRunner({
		baseUrl: `http://${container.getHost()}:${container.getMappedPort(GO_JUDGE_PORT)}`,
		maxConcurrentRuns: 2
	});
}, 900_000);

afterAll(async () => {
	await container.stop();
});

describe('languages', () => {
	it('lists the languages of the image with their toolchain versions', async () => {
		const result = await runner.languages();
		if (!result.ok) throw new Error(result.error.message);
		const keys = result.value.map((language) => language.key).sort();
		expect(keys).toEqual(['cpp17', 'go', 'java21', 'javascript', 'python3', 'typescript']);
		for (const language of result.value) expect(language.version).toMatch(/^\d+(\.\d+)+$/);
	});
});

describe('verdicts', () => {
	it.each(Object.keys(SUM_SOURCES))('accepts a correct %s solution', async (language) => {
		const response = await run(request(language, SUM_SOURCES[language] ?? '', { tests: SUM_TESTS }));
		expect(response.tests.map((test) => [test.id, test.verdict])).toEqual([
			['open', 'accepted'],
			['hidden', 'accepted']
		]);
		expect(response.language.key).toBe(language);
		expect(response.engine).toEqual({ name: 'go-judge', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string });
		const [open, hidden] = response.tests;
		expect(open?.stdoutPreview).toBe('3\n');
		// A hidden test shows neither its input nor the program's output.
		expect(hidden?.stdoutPreview).toBeNull();
		expect(hidden?.stdoutSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('gives wrong_answer per test, and checks tokens and floats when asked', async () => {
		const source = 'print(int(input()) * 2)\n';
		const tests = [
			{ id: 'right', stdin: '2', expected: '4', hidden: false },
			{ id: 'wrong', stdin: '3', expected: '7', hidden: false }
		];
		const response = await run(request('python3', source, { tests }));
		expect(response.tests.map((test) => test.verdict)).toEqual(['accepted', 'wrong_answer']);

		const floats = await run(
			request('python3', 'print(1 / 3, "ok")\n', {
				tests: [{ id: 'f', stdin: '', expected: '0.3333 ok', hidden: false }],
				checker: { kind: 'float_eps', eps: 1e-3 }
			})
		);
		expect(floats.tests[0]?.verdict).toBe('accepted');
	});

	it('gives time_limit to an endless loop by CPU time and to a sleeping program by wall time', async () => {
		const spinning = await run(request('cpp17', 'int main() { volatile unsigned long x = 0; for (;;) x++; }\n'));
		expect(spinning.tests[0]?.verdict).toBe('time_limit');
		expect(spinning.tests[0]?.cpuTimeMs).toBeGreaterThanOrEqual(LIMITS.cpuTimeMs);

		const sleeping = await runPython('import time\ntime.sleep(60)\n', { limits: { wallTimeMs: 1_000 } });
		expect(sleeping.verdict).toBe('time_limit');
		expect(sleeping.wallTimeMs).toBeGreaterThanOrEqual(1_000);
		expect(sleeping.wallTimeMs).toBeLessThan(3_000);
	});

	it('gives memory_limit when a program takes more than its memory', async () => {
		const response = await run(
			request(
				'cpp17',
				'#include <cstdio>\n#include <vector>\nint main() { std::vector<char> v(600 << 20, 1); std::printf("%d", v[12345]); }\n',
				{ limits: { ...LIMITS, memoryMb: 128 } }
			)
		);
		expect(response.tests[0]?.verdict).toBe('memory_limit');

		const java = await run(
			request(
				'java21',
				'import java.util.*;\npublic class Main { public static void main(String[] a) { List<long[]> l = new ArrayList<>(); while (true) l.add(new long[1 << 20]); } }\n'
			)
		);
		expect(java.tests[0]?.verdict).toBe('memory_limit');
	});

	it('gives runtime_error with the exit code or the signal', async () => {
		const exit = await runPython('raise SystemExit(3)\n');
		expect(exit).toMatchObject({ verdict: 'runtime_error', exitCode: 3, signal: null });

		const crash = await run(request('cpp17', 'int main() { volatile int *p = nullptr; return *p; }\n'));
		expect(crash.tests[0]).toMatchObject({ verdict: 'runtime_error', exitCode: null, signal: 'SIGSEGV' });
	});

	it('gives compile_error to every test and keeps the compiler message', async () => {
		const response = await run(request('cpp17', 'int main() { return undefined_name; }\n', { tests: SUM_TESTS }));
		expect(response.compile?.status).toBe('compile_error');
		expect(response.compile?.stderr).toContain('undefined_name');
		expect(response.tests.map((test) => test.verdict)).toEqual(['compile_error', 'compile_error']);

		const typescript = await run(request('typescript', 'enum Color { Red }\nconsole.log(Color.Red);\n'));
		expect(typescript.compile?.status).toBe('compile_error');
		expect(typescript.compile?.stderr).toContain('enum');
	});

	it('gives output_limit to output above the limit and accepts output exactly at it', async () => {
		const flood = await runPython('import sys\nwhile True:\n    sys.stdout.write("x" * 4096)\n', {
			limits: { outputKb: 16 }
		});
		expect(flood.verdict).toBe('output_limit');
		expect(flood.wallTimeMs).toBeLessThan(LIMITS.wallTimeMs);

		const exact = await run(
			request('python3', 'import sys\nsys.stdout.write("x" * 16384)\n', {
				tests: [{ id: 'exact', stdin: '', expected: 'x'.repeat(16384), hidden: false }],
				limits: { ...LIMITS, outputKb: 16 }
			})
		);
		expect(exact.tests[0]?.verdict).toBe('accepted');
		expect(exact.tests[0]?.stdoutPreview).toHaveLength(1024);
	});
});

describe('isolation', () => {
	it('has no network: only a loopback that is down, no route anywhere', async () => {
		const source = [
			'import socket',
			'with open("/proc/net/dev") as f:',
			'    print(" ".join(sorted(line.split(":")[0].strip() for line in f.readlines()[2:])))',
			// go-judge itself listens on 5050 in the container; the program must not reach it or anything else.
			'for host, port in [("127.0.0.1", 5050), ("1.1.1.1", 53), ("10.0.0.1", 80)]:',
			'    s = socket.socket()',
			'    s.settimeout(2)',
			'    try:',
			'        s.connect((host, port))',
			'        print(host, "connected")',
			'    except OSError:',
			'        print(host, "blocked")',
			'try:',
			'    socket.getaddrinfo("example.com", 443)',
			'    print("dns resolved")',
			'except OSError:',
			'    print("dns blocked")'
		].join('\n');
		const expected = ['lo', '127.0.0.1 blocked', '1.1.1.1 blocked', '10.0.0.1 blocked', 'dns blocked', ''].join('\n');
		const result = await runPython(source, { expected });
		expect(result.stdoutPreview).toBe(expected);
		expect(result.verdict).toBe('accepted');
	});

	it('writes only to its working directory and /tmp, and nothing survives the run', async () => {
		const source = [
			'import os',
			'for path in ["/w/own", "/tmp/own", "/etc/x", "/usr/x", "/x", "/bin/x", "/dev/x", "/proc/x"]:',
			'    try:',
			'        with open(path, "w") as f:',
			'            f.write("1")',
			'        print(path, "written")',
			'    except OSError:',
			'        print(path, "denied")',
			'print(os.getuid(), os.getgid(), os.getgroups())'
		].join('\n');
		const first = await runPython(source);
		expect(first.stdoutPreview?.split('\n')).toEqual([
			'/w/own written',
			'/tmp/own written',
			'/etc/x denied',
			'/usr/x denied',
			'/x denied',
			'/bin/x denied',
			'/dev/x denied',
			'/proc/x denied',
			'1536 1536 []',
			''
		]);

		const second = await runPython('import os\nprint(os.path.exists("/w/own"), os.path.exists("/tmp/own"))\n');
		expect(second.stdoutPreview).toBe('False False\n');
	});

	it('keeps the program from namespaces, mounts and other kernel interfaces a solution does not need', async () => {
		// Each call is refused by the program's own system call filter, not by a missing privilege: without it a user
		// namespace (and a mount inside it) by unshare, clone, clone3 and the 32-bit entry, a netlink socket and ptrace
		// succeed here. The rest are refused today by the container's profile or the host's settings as well; the filter
		// keeps them refused if those change.
		const probe = [
			'#include <cstdio>',
			'#include <cstring>',
			'#include <cerrno>',
			'#include <csignal>',
			'#include <fcntl.h>',
			'#include <linux/io_uring.h>',
			'#include <linux/perf_event.h>',
			'#include <linux/sched.h>',
			'#include <sched.h>',
			'#include <sys/mount.h>',
			'#include <sys/ptrace.h>',
			'#include <sys/socket.h>',
			'#include <sys/syscall.h>',
			'#include <sys/wait.h>',
			'#include <unistd.h>',
			'static void report(const char *name, long result) {',
			'\tstd::printf("%s %s\\n", name, result < 0 ? strerrorname_np(errno) : "allowed");',
			'\tstd::fflush(stdout);',
			'}',
			'static long child(long pid) {',
			'\tif (pid == 0) _exit(0);',
			'\tif (pid > 0) waitpid(pid, nullptr, 0);',
			'\treturn pid;',
			'}',
			// A call that changes the process runs in a child of its own, so each probe starts from the same state.
			'template <typename Call> static void apart(const char *name, Call call) {',
			'\tpid_t pid = fork();',
			'\tif (pid == 0) { report(name, call()); _exit(0); }',
			'\twaitpid(pid, nullptr, 0);',
			'}',
			'int main() {',
			'\tapart("unshare", [] { return (long)unshare(CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWNS); });',
			'\tapart("mount", [] {',
			'\t\tunshare(CLONE_NEWUSER | CLONE_NEWNS);',
			'\t\treturn (long)mount("none", "/tmp", "tmpfs", 0, nullptr);',
			'\t});',
			'\tapart("clone", [] { return child(syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0)); });',
			'\tapart("clone3", [] {',
			'\t\tstruct clone_args args;',
			'\t\tstd::memset(&args, 0, sizeof args);',
			'\t\targs.flags = CLONE_NEWUSER;',
			'\t\targs.exit_signal = SIGCHLD;',
			'\t\treturn child(syscall(SYS_clone3, &args, sizeof args));',
			'\t});',
			// The 32-bit system call entry has its own numbers (310 is unshare there); a filter of 64-bit calls only
			// would let it through.
			'\tapart("unshare_i386", [] {',
			'\t\tlong result;',
			'\t\tasm volatile("int $0x80" : "=a"(result) : "a"(310), "b"(CLONE_NEWUSER) : "memory");',
			'\t\tif (result < 0) { errno = -result; result = -1; }',
			'\t\treturn result;',
			'\t});',
			'\treport("setns", setns(0, CLONE_NEWNET));',
			'\treport("netlink", socket(AF_NETLINK, SOCK_RAW, 0));',
			'\tstruct io_uring_params params;',
			'\tstd::memset(&params, 0, sizeof params);',
			'\treport("io_uring", syscall(SYS_io_uring_setup, 1, &params));',
			'\treport("userfaultfd", syscall(SYS_userfaultfd, 1));',
			'\treport("keyctl", syscall(SYS_keyctl, 0, -3, 1));',
			'\tstruct perf_event_attr attr;',
			'\tstd::memset(&attr, 0, sizeof attr);',
			'\tattr.type = PERF_TYPE_SOFTWARE;',
			'\tattr.size = sizeof attr;',
			'\tattr.config = PERF_COUNT_SW_TASK_CLOCK;',
			'\tattr.exclude_kernel = 1;',
			'\treport("perf_event_open", syscall(SYS_perf_event_open, &attr, 0, -1, -1, 0));',
			'\tpid_t pid = fork();',
			'\treport("fork", child(pid));',
			// Last: a traced program stops at its next signal, which the engine does not expect.
			'\treport("ptrace", ptrace(PTRACE_TRACEME, 0, nullptr, nullptr));',
			'}'
		].join('\n');
		const refused = [
			'unshare EPERM',
			'mount EPERM',
			'clone EPERM',
			// glibc falls back to clone when clone3 is missing, so it is refused as missing.
			'clone3 ENOSYS',
			'unshare_i386 EPERM',
			'setns EPERM',
			'netlink EPERM',
			'io_uring EPERM',
			'userfaultfd EPERM',
			'keyctl EPERM',
			'perf_event_open EPERM',
			'fork allowed',
			'ptrace EPERM',
			''
		].join('\n');
		const c = await run(
			request('cpp17', probe, {
				tests: [{ id: 'probe', stdin: '', expected: refused, hidden: false }],
				limits: { ...LIMITS, processes: 4 }
			})
		);
		expect(c.tests[0]?.stdoutPreview).toBe(refused);

		const python = [
			'import ctypes, errno, os, socket, threading',
			'libc = ctypes.CDLL(None, use_errno=True)',
			'def report(name, call):',
			'    try:',
			'        call()',
			'        print(name, "allowed")',
			'    except OSError as error:',
			'        print(name, errno.errorcode[error.errno])',
			'def mount():',
			'    if libc.mount(b"none", b"/tmp", b"tmpfs", 0, None) != 0:',
			'        raise OSError(ctypes.get_errno(), "mount")',
			'report("unshare", lambda: os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET | os.CLONE_NEWNS))',
			'report("mount", mount)',
			'report("netlink", lambda: socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0))',
			'report("unix", lambda: socket.socketpair())',
			'worker = threading.Thread(target=lambda: print("thread ran"))',
			'worker.start()',
			'worker.join()'
		].join('\n');
		const expected = ['unshare EPERM', 'mount EPERM', 'netlink EPERM', 'unix allowed', 'thread ran', ''].join('\n');
		const result = await runPython(python, { expected, limits: { processes: 4 } });
		expect(result.stdoutPreview).toBe(expected);
		expect(result.verdict).toBe('accepted');
	});

	it('stops a fork bomb at the process limit', async () => {
		const counting = await run(
			request(
				'cpp17',
				[
					'#include <cstdio>',
					'#include <unistd.h>',
					'int main() {',
					'\tint started = 0;',
					'\tfor (int i = 0; i < 1000; i++) {',
					'\t\tpid_t pid = fork();',
					'\t\tif (pid == 0) { pause(); _exit(0); }',
					'\t\tif (pid < 0) break;',
					'\t\tstarted++;',
					'\t}',
					'\tstd::printf("%d\\n", started);',
					'}'
				].join('\n'),
				{
					tests: [{ id: 'count', stdin: '', expected: '3', hidden: false }],
					limits: { ...LIMITS, processes: 4 }
				}
			)
		);
		// The program itself plus three children: the fourth fork fails.
		expect(counting.tests[0]?.verdict).toBe('accepted');

		const bomb = await run(
			request('cpp17', '#include <unistd.h>\nint main() { for (;;) fork(); }\n', {
				limits: { ...LIMITS, processes: 16, cpuTimeMs: 1_000, wallTimeMs: 2_000 }
			})
		);
		expect(bomb.tests[0]?.verdict).toBe('time_limit');
		// The sandbox is still healthy afterwards.
		expect((await runPython('print(1)\n', { expected: '1' })).verdict).toBe('accepted');
	});
});

describe('adapter errors', () => {
	it('refuses an invalid request and an unknown language without running anything', async () => {
		const invalid = await runner.run(request('python3', 'print(1)', { tests: [] }));
		expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_request', retryable: false } });

		const tooLong = await runner.run(request('python3', 'x'.repeat(64 * 1024 + 1)));
		expect(tooLong).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

		const unknown = await runner.run(request('cobol', 'DISPLAY 1'));
		expect(unknown).toMatchObject({ ok: false, error: { code: 'unsupported_language', retryable: false } });
	});

	it('answers busy above the concurrent run limit', async () => {
		const slow = request('python3', 'import time\ntime.sleep(1)\n');
		const results = await Promise.all([runner.run(slow), runner.run(slow), runner.run(slow)]);
		expect(results.filter((result) => result.ok)).toHaveLength(2);
		expect(results.filter((result) => !result.ok)).toEqual([
			{ ok: false, error: expect.objectContaining({ code: 'busy', retryable: true }) as unknown }
		]);
	});

	it('answers unavailable when the sandbox cannot be reached', async () => {
		const offline = new GoJudgeRunner({ baseUrl: 'http://127.0.0.1:9', maxConcurrentRuns: 1 });
		expect(await offline.languages()).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
		expect(await offline.run(request('python3', 'print(1)'))).toMatchObject({
			ok: false,
			error: { code: 'unavailable', retryable: true }
		});
	});
});

describe('artifacts', () => {
	let database: TestDatabase;

	beforeAll(async () => {
		database = await createTestDatabase();
	});

	afterAll(async () => {
		await database.drop();
	});

	it('fit assessment_artifacts: the code before the run, the compile step and every test after it', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const [assessment] = await db
			.insert(assessments)
			.values({ kind: 'code_task', title: 'A + B', skillKeys: ['cpp'] })
			.returning();
		if (!assessment) throw new Error('assessment not inserted');
		const [version] = await db
			.insert(assessmentVersions)
			.values({
				assessmentId: assessment.id,
				version: 1,
				contentSha256: 'a'.repeat(64),
				scorer: { type: 'sandbox_judge', version: 1 },
				levelScale: {},
				coverage: {},
				status: 'published'
			})
			.returning();
		if (!version) throw new Error('version not inserted');
		const [attempt] = await db
			.insert(assessmentAttempts)
			.values({
				candidateId: candidate.id,
				versionId: version.id,
				startedAt: new Date(),
				deadlineAt: new Date(Date.now() + 3_600_000),
				status: 'started'
			})
			.returning();
		if (!attempt) throw new Error('attempt not inserted');

		const runRequest = request('cpp17', SUM_SOURCES.cpp17 ?? '', { tests: SUM_TESTS });
		const drafts = [codeSubmissionArtifact(runRequest), ...runResultArtifacts(await run(runRequest), runRequest.tests)];
		expect(drafts.map((draft) => [draft.kind, draft.content.stage ?? null, draft.content.test_id ?? null])).toEqual([
			['code_submission', null, null],
			['run_result', 'compile', null],
			['run_result', 'test', 'open'],
			['run_result', 'test', 'hidden']
		]);
		expect(drafts[3]?.content).toMatchObject({ hidden: true, verdict: 'accepted', stdout_preview: null });
		// The same content hashes the same regardless of key order.
		expect(codeSubmissionArtifact({ ...runRequest }).sha256).toBe(drafts[0]?.sha256);

		const rows = await db
			.insert(assessmentArtifacts)
			.values(
				drafts.map((draft, index) => ({
					attemptId: attempt.id,
					seq: index + 1,
					kind: draft.kind,
					content: draft.content,
					sha256: draft.sha256,
					retentionUntil: '2027-10-01'
				}))
			)
			.returning();
		expect(rows).toHaveLength(4);
	});
});
