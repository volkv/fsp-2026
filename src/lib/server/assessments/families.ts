// The bank tree as the test engine reads it (docs/domain.md, 10.1): one directory per family,
// `assessments/families/<specialization>/<family key>/`, with the descriptor `descriptor.json` (a `FamilyDescriptor` of the
// contract) and the generator `generator.ts` (a `FamilyModule` of the contract: `generate`, and `harness` for QA). The
// generator is plain erasable TypeScript run by Node itself: the release script, the server and the worker import the
// same file, and the release records the SHA-256 of its text. Shared code of the generators lives in directories whose
// name starts with `_`; the release records one SHA-256 of the shared files its generators import (`shared-code.ts`).
// `gate-sources.json` at the root is the factory's record of the source every family last passed its admission gates
// with (10.2, `scripts/assessments/gates.ts`); a family is released only while that record is its current source.
//
// Plain erasable TypeScript without `$lib`: the release script runs it with bare Node.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { familySourceSha256, type FamilyDescriptor, type FamilyModule } from './contract/bank.ts';
import { SPECIALIZATION_KEYS, type SpecializationKey } from './contract/catalog.ts';
import { sharedClosureSha256 } from './shared-code.ts';

export const DESCRIPTOR_FILE = 'descriptor.json';
export const GENERATOR_FILE = 'generator.ts';

export const GATE_SOURCES_FILE = 'gate-sources.json';

/** A family directory as the engine serves it: the descriptor and the generator, checked by the hash of its text. */
export interface FamilyCode {
	descriptor: FamilyDescriptor;
	/** SHA-256 of the text of `generator.ts`; the release records it and the engine checks it before serving. */
	generatorSha256: string;
	/** `familySourceSha256` of the contract: the sources reviews and Angoff ratings are made on. */
	sourceSha256: string;
	module: FamilyModule;
}

/** The gate run of a family: the source the gates check now and the one `gate-sources.json` records as passed. */
export interface GateRecord {
	/** `gateSourceSha256` of the family as it is on disk. */
	current: string;
	/** `null` — no passed gate run recorded: the gates failed or never ran. */
	recorded: string | null;
}

export interface LoadedFamily extends FamilyCode {
	gate: GateRecord;
}

export class BankTreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BankTreeError';
	}
}

export const sha256Hex = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

function isFamilyModule(value: unknown): value is FamilyModule {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.generate === 'function' && (record.harness === undefined || typeof record.harness === 'function')
	);
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * The source a gate run checks: the family's sources (`familySourceSha256`) and the shared code its generator imports
 * (the import closure in the `_*` directories). A change in either makes the gate record stale; shared code the family
 * never imports does not.
 */
export const gateSourceSha256 = (sourceSha256: string, sharedSha256: string): string =>
	createHash('sha256').update(sourceSha256).update('\0').update(sharedSha256).digest('hex');

/** `gate-sources.json` of the tree under `root`: family key → `gateSourceSha256` of its last passed gate run. */
export async function readGateSources(root: string): Promise<Record<string, string>> {
	let text: string;
	try {
		text = await readFile(join(root, GATE_SOURCES_FILE), 'utf8');
	} catch (error) {
		// No record at all: no family of the tree has passed its gates.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
	return JSON.parse(text) as Record<string, string>;
}

/** One family directory: the descriptor must name the directory's specialization and key. */
export async function loadFamily(
	directory: string,
	specialization: SpecializationKey,
	key: string
): Promise<FamilyCode> {
	const where = `${specialization}/${key}`;
	const descriptor = JSON.parse(await readFile(join(directory, DESCRIPTOR_FILE), 'utf8')) as FamilyDescriptor;
	if (descriptor.specialization !== specialization || descriptor.key !== key) {
		throw new BankTreeError(`${where}: the descriptor names ${descriptor.specialization}/${descriptor.key}`);
	}
	const generatorPath = join(directory, GENERATOR_FILE);
	const source = await readFile(generatorPath);
	const imported: unknown = await import(/* @vite-ignore */ pathToFileURL(generatorPath).href);
	if (!isFamilyModule(imported)) throw new BankTreeError(`${where}: ${GENERATOR_FILE} does not export generate()`);
	return {
		descriptor,
		generatorSha256: sha256Hex(source),
		sourceSha256: familySourceSha256(descriptor, source.toString('utf8')),
		module: { generate: imported.generate, ...(imported.harness ? { harness: imported.harness } : {}) }
	};
}

/**
 * Every family of a specialization under `root` (`assessments/families`), in the order of keys. A directory without a
 * descriptor is a defect of the tree, not a family to skip.
 */
export async function loadSpecializationFamilies(
	root: string,
	specialization: SpecializationKey
): Promise<LoadedFamily[]> {
	const directory = join(root, specialization);
	if (!(await isDirectory(directory))) return [];
	const keys = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.sort();
	const gates = await readGateSources(root);
	const families: LoadedFamily[] = [];
	for (const key of keys) {
		const family = await loadFamily(join(directory, key), specialization, key);
		const shared = sharedClosureSha256(root, [join(directory, key, GENERATOR_FILE)]);
		families.push({
			...family,
			gate: { current: gateSourceSha256(family.sourceSha256, shared), recorded: gates[key] ?? null }
		});
	}
	return families;
}

/**
 * SHA-256 of the shared code a specialization's generators run: the import closure of its `generator.ts` files in the
 * `_*` directories of the tree (`sharedClosureSha256`), by relative path and content. Shared code no generator of the
 * specialization imports does not change it. No families — the hash of nothing.
 */
export async function sharedCodeSha256(root: string, specialization: SpecializationKey): Promise<string> {
	const directory = join(root, specialization);
	if (!(await isDirectory(directory))) return sharedClosureSha256(root, []);
	const generators = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
		.map((entry) => join(directory, entry.name, GENERATOR_FILE))
		.sort();
	return sharedClosureSha256(root, generators);
}

export interface LoadedBank {
	families: LoadedFamily[];
	sharedSha256: string;
}

/** The bank of a specialization as loaded, or why it cannot be: a broken family closes its own specialization only. */
export type BankLoad = { ok: true; bank: LoadedBank } | { ok: false; error: string };

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The families of every specialization present under `root`, with the hash of their shared code. A specialization whose
 * families cannot be loaded — a descriptor that does not parse or names another family, a generator that does not
 * import — is in the tree with the error, so its release is refused and the others go on.
 */
export async function loadBankTree(root: string): Promise<Map<SpecializationKey, BankLoad>> {
	const tree = new Map<SpecializationKey, BankLoad>();
	for (const specialization of SPECIALIZATION_KEYS) {
		try {
			const families = await loadSpecializationFamilies(root, specialization);
			if (families.length > 0)
				tree.set(specialization, {
					ok: true,
					bank: { families, sharedSha256: await sharedCodeSha256(root, specialization) }
				});
		} catch (error) {
			tree.set(specialization, { ok: false, error: errorMessage(error) });
		}
	}
	return tree;
}

/** The code a release of a specialization runs: the hash of every generator by family key and of the shared code. */
export interface BankCode {
	generators: ReadonlyMap<string, string>;
	sharedSha256: string;
}

export const loadedBankCode = (bank: LoadedBank): BankCode => ({
	generators: new Map(bank.families.map((f) => [f.descriptor.key, f.generatorSha256])),
	sharedSha256: bank.sharedSha256
});

/**
 * The code of a specialization's bank on disk, by the text of its files only — nothing is imported: the generator of
 * every family directory and the shared code they import.
 */
export async function treeBankCode(root: string, specialization: SpecializationKey): Promise<BankCode> {
	const directory = join(root, specialization);
	const generators = new Map<string, string>();
	const paths: string[] = [];
	if (await isDirectory(directory)) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
			const path = join(directory, entry.name, GENERATOR_FILE);
			let text: Buffer;
			try {
				text = await readFile(path);
			} catch (error) {
				// A family directory without a generator runs no code: a release that recorded one finds it missing.
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
			generators.set(entry.name, sha256Hex(text));
			paths.push(path);
		}
	}
	return { generators, sharedSha256: sharedClosureSha256(root, paths.sort()) };
}

/**
 * What of the code a release was checked with the bank no longer has: a generator of another text or gone, other shared
 * code. Empty — the bank runs the release's code exactly; otherwise serving it would run code its checks never saw.
 */
export function codeDrift(
	release: { families: readonly { descriptor: { key: string }; generatorSha256: string }[]; sharedSha256: string },
	code: BankCode
): string[] {
	const drift: string[] = [];
	for (const { descriptor, generatorSha256 } of release.families) {
		const now = code.generators.get(descriptor.key);
		if (now === undefined) drift.push(`the generator of ${descriptor.key} is gone`);
		else if (now !== generatorSha256) drift.push(`the generator of ${descriptor.key} changed`);
	}
	if (release.sharedSha256 !== code.sharedSha256) drift.push('the shared code changed');
	return drift;
}
