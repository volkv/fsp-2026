// The language set of the sandbox image (services/sandbox/languages.json, versions filled in at image build). The
// image is the source of truth: the adapter reads the file from inside the sandbox, so commands and versions always
// belong to the toolchains that actually run the code.
import { z } from 'zod';
import type { LanguageSpec } from './types';

/** Where programs see the resolved language file (services/sandbox/mount.yaml). */
export const LANGUAGES_PATH = '/etc/sandbox/languages.json';

const envEntry = z.string().regex(/^[A-Z_][A-Z0-9_]*=/, 'must be NAME=value');

const stepSchema = z.object({
	args: z.array(z.string().min(1)).min(1),
	/** Processes and threads the toolchain itself needs (cgroup pids). */
	tasks: z.number().int().positive(),
	env: z.array(envEntry)
});

const fileName = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'must be a plain file name');

const languageSchema = z.object({
	key: z.string().regex(/^[a-z0-9_]+$/),
	title: z.string().min(1),
	version: z.string().min(1),
	sourceFile: fileName,
	compile: stepSchema.nullable(),
	/** Files the compile step leaves for the run step. */
	artifacts: z.array(fileName),
	run: stepSchema
});

export const languageFileSchema = z
	.object({ env: z.array(envEntry), languages: z.array(languageSchema).min(1) })
	.refine((file) => new Set(file.languages.map((language) => language.key)).size === file.languages.length, {
		message: 'language keys must be unique'
	})
	.refine((file) => file.languages.every((language) => language.compile !== null || language.artifacts.length === 0), {
		message: 'only a language with a compile step can have artifacts'
	});

export type LanguageFile = z.infer<typeof languageFileSchema>;
export type SandboxLanguage = LanguageFile['languages'][number] & { baseEnv: string[] };

/** Placeholder in run arguments replaced with the memory limit of the test, e.g. the JVM heap `-Xmx{memory_mb}m`. */
const MEMORY_PLACEHOLDER = '{memory_mb}';

export function languagesOf(file: LanguageFile): SandboxLanguage[] {
	return file.languages.map((language) => ({ ...language, baseEnv: file.env }));
}

export function languageSpec(language: SandboxLanguage): LanguageSpec {
	return {
		key: language.key,
		version: language.version,
		sourceFile: language.sourceFile,
		compile: language.compile ? [...language.compile.args] : null,
		run: [...language.run.args]
	};
}

export function runArgs(language: SandboxLanguage, memoryMb: number): string[] {
	return language.run.args.map((arg) => arg.replaceAll(MEMORY_PLACEHOLDER, String(memoryMb)));
}

/** Environment of a step: the common variables, then the step's own, a later value of a name replacing an earlier. */
export function stepEnv(language: SandboxLanguage, step: 'compile' | 'run'): string[] {
	const own = step === 'compile' ? (language.compile?.env ?? []) : language.run.env;
	const merged = new Map<string, string>();
	for (const entry of [...language.baseEnv, ...own]) {
		const separator = entry.indexOf('=');
		merged.set(entry.slice(0, separator), entry);
	}
	return [...merged.values()];
}
