// The bank tree as the test engine reads it (docs/domain.md, 10.1): one directory per family,
// `assessments/families/<specialization>/<family key>/`, with the descriptor `descriptor.json` (a `FamilyDescriptor` of the
// contract) and the generator `generator.ts` (a `FamilyModule` of the contract: `generate`, and `harness` for QA). The
// generator is plain erasable TypeScript run by Node itself: the release script, the server and the worker import the
// same file, and the release records the SHA-256 of its text. Shared code of the generators lives in directories whose
// name starts with `_`; the release records one SHA-256 of the shared files its generators import (`shared-code.ts`).
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

export interface LoadedFamily {
	descriptor: FamilyDescriptor;
	/** SHA-256 of the text of `generator.ts`; the release records it and the engine checks it before serving. */
	generatorSha256: string;
	/** `familySourceSha256` of the contract: the sources reviews and Angoff ratings are made on. */
	sourceSha256: string;
	module: FamilyModule;
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

/** One family directory: the descriptor must name the directory's specialization and key. */
export async function loadFamily(
	directory: string,
	specialization: SpecializationKey,
	key: string
): Promise<LoadedFamily> {
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
	const families: LoadedFamily[] = [];
	for (const key of keys) families.push(await loadFamily(join(directory, key), specialization, key));
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

/** The families of every specialization present under `root`, with the hash of their shared code. */
export async function loadBankTree(root: string): Promise<Map<SpecializationKey, LoadedBank>> {
	const tree = new Map<SpecializationKey, LoadedBank>();
	for (const specialization of SPECIALIZATION_KEYS) {
		const families = await loadSpecializationFamilies(root, specialization);
		if (families.length > 0)
			tree.set(specialization, { families, sharedSha256: await sharedCodeSha256(root, specialization) });
	}
	return tree;
}
