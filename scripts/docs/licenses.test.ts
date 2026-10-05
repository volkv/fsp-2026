// The licence check of the documentation build: a licence outside the allowed list stops the build unless an exception
// with a reason covers exactly that component and licence; uv.lock is read down to the runtime closure.
import { describe, expect, it } from 'vitest';
import type { LicenseException } from './license-data.ts';
import {
	checkLicenses,
	dockerfilePackages,
	isAllowed,
	LicenseCheckError,
	parseImageReference,
	pythonRuntimePackages,
	type Component
} from './licenses.ts';

const ALLOWED = { MIT: 'test', 'Apache-2.0': 'test', 'BSD-3-Clause': 'test' };

function component(name: string, license: string): Component {
	return { kind: 'npm', name, version: '1.0.0', license, source: 'test' };
}

function problemsOf(run: () => unknown): readonly string[] {
	try {
		run();
	} catch (error) {
		if (error instanceof LicenseCheckError) return error.problems;
		throw error;
	}
	throw new Error('the check passed');
}

describe('isAllowed', () => {
	it('accepts an expression with one allowed alternative and rejects one that needs a forbidden licence', () => {
		expect(isAllowed('MIT', ALLOWED)).toBe(true);
		expect(isAllowed('(GPL-3.0-only OR MIT)', ALLOWED)).toBe(true);
		expect(isAllowed('MIT AND Apache-2.0', ALLOWED)).toBe(true);
		expect(isAllowed('MIT AND GPL-3.0-only', ALLOWED)).toBe(false);
		expect(isAllowed('GPL-2.0-only WITH Classpath-exception-2.0', ALLOWED)).toBe(false);
		expect(isAllowed('MIT OR (Apache-2.0 AND GPL-3.0-only)', ALLOWED)).toBe(false);
		expect(isAllowed('', ALLOWED)).toBe(false);
	});
});

describe('checkLicenses', () => {
	it('passes allowed licences', () => {
		expect(checkLicenses([component('a', 'MIT'), component('b', 'Apache-2.0 OR GPL-3.0-only')], [], ALLOWED)).toEqual(
			[]
		);
	});

	it('fails on a forbidden licence without an exception', () => {
		expect(problemsOf(() => checkLicenses([component('a', 'MIT'), component('b', 'GPL-3.0-only')], [], ALLOWED))).toEqual(
			['npm b@1.0.0 (GPL-3.0-only): licence is not allowed and has no exception in license-data.ts']
		);
	});

	it('fails on a licence that is not an SPDX expression', () => {
		expect(problemsOf(() => checkLicenses([component('a', 'SEE LICENSE IN LICENSE.txt')], [], ALLOWED))).toHaveLength(1);
	});

	it('accepts a forbidden licence only through an exception for that component and licence', () => {
		const exception: LicenseException = { kind: 'npm', name: 'b', license: 'GPL-3.0-only', reason: 'test tool' };
		const excepted = checkLicenses([component('b', 'GPL-3.0-only')], [exception], ALLOWED);
		expect(excepted.map((entry) => entry.exception)).toEqual([exception]);

		expect(problemsOf(() => checkLicenses([component('b', 'AGPL-3.0-only')], [exception], ALLOWED))).toEqual([
			'npm b@1.0.0 (AGPL-3.0-only): the exception was granted for GPL-3.0-only'
		]);
		const otherKind: LicenseException = { ...exception, kind: 'python' };
		expect(problemsOf(() => checkLicenses([component('b', 'GPL-3.0-only')], [otherKind], ALLOWED))).toHaveLength(2);
	});

	it('fails on a stale exception', () => {
		const exception: LicenseException = { kind: 'npm', name: 'a', license: 'GPL-3.0-only', reason: 'gone' };
		expect(problemsOf(() => checkLicenses([], [exception], ALLOWED))).toEqual([
			'exception npm a matches no component'
		]);
		expect(problemsOf(() => checkLicenses([component('a', 'MIT')], [exception], ALLOWED))).toEqual([
			'exception npm a is not needed: its licence is allowed'
		]);
	});
});

describe('pythonRuntimePackages', () => {
	const lock = [
		'version = 1',
		'',
		'[[package]]',
		'name = "app"',
		'version = "1.0.0"',
		'source = { virtual = "." }',
		'dependencies = [',
		'    { name = "Web_Server" },',
		'    { name = "winonly", marker = "sys_platform == \'win32\'" },',
		']',
		'',
		'[package.dev-dependencies]',
		'dev = [',
		'    { name = "pytest" },',
		']',
		'',
		'[[package]]',
		'name = "web-server"',
		'version = "2.0.0"',
		'source = { registry = "https://pypi.org/simple" }',
		'dependencies = [',
		'    { name = "cffi", marker = "implementation_name != \'PyPy\'" },',
		']',
		'',
		'[[package]]',
		'name = "cffi"',
		'version = "3.0.0"',
		'source = { registry = "https://pypi.org/simple" }',
		'',
		'[[package]]',
		'name = "winonly"',
		'version = "1.0.0"',
		'source = { registry = "https://pypi.org/simple" }',
		'',
		'[[package]]',
		'name = "pytest"',
		'version = "9.0.0"',
		'source = { registry = "https://pypi.org/simple" }',
		''
	].join('\n');

	it('follows runtime dependencies on Linux CPython and leaves out the development group', () => {
		expect(pythonRuntimePackages(lock).map((entry) => `${entry.name}@${entry.version}`)).toEqual([
			'cffi@3.0.0',
			'web-server@2.0.0'
		]);
	});
});

describe('Dockerfile and image parsing', () => {
	it('reads apt, apk and go install packages with their pinned versions', () => {
		const dockerfile = [
			'ARG GO_JUDGE_VERSION=v1.12.3',
			'ARG DEBIAN_SNAPSHOT=20260924T000000Z',
			'ARG KOTLIN_VERSION=2.4.20',
			'RUN go install -tags seccomp \\',
			'\t\tgithub.com/criyle/go-judge/cmd/go-judge@${GO_JUDGE_VERSION}',
			'RUN apt-get update \\',
			'\t&& apt-get install -y --no-install-recommends \\',
			'\t\tpoppler-utils \\',
			'\t\ttini \\',
			'\t&& rm -rf /var/lib/apt/lists/*',
			'RUN apk add --no-cache openssh-server && adduser x'
		].join('\n');
		expect(dockerfilePackages(dockerfile)).toEqual([
			{ name: 'poppler-utils', version: 'снимок Debian 20260924T000000Z' },
			{ name: 'tini', version: 'снимок Debian 20260924T000000Z' },
			{ name: 'openssh-server', version: 'репозиторий Alpine базового образа' },
			{ name: 'github.com/criyle/go-judge/cmd/go-judge', version: 'v1.12.3' },
			{ name: 'kotlin-compiler', version: '2.4.20' }
		]);
	});

	it('splits an image reference into repository and tag', () => {
		expect(parseImageReference('ghcr.io/ggml-org/llama.cpp:server-b11176')).toEqual({
			repository: 'ghcr.io/ggml-org/llama.cpp',
			tag: 'server-b11176',
			pinned: false
		});
		expect(parseImageReference('alpine:3.24.2@sha256:294b')).toEqual({ repository: 'alpine', tag: '3.24.2', pinned: true });
		expect(() => parseImageReference('localhost:5000/app')).toThrow('has no tag');
	});
});
