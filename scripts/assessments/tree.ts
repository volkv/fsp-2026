// The bank tree as the factory reads it (docs/domain.md, 10.1): `assessments/families/<specialization>/<key>/` with
// `descriptor.json` and `generator.ts`; shared code in directories starting with `_` (`_lib`); probes of mechanisms
// that are not released yet in `_probes/<specialization>/<key>/` in the same layout. Beyond the contract's `generate`,
// a generator exports `build` — the instance with the material the gates prove its answer by.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FactoryModule } from '../../assessments/families/_lib/family.ts';
import {
	familySourceSha256 as contractFamilySourceSha256,
	type FamilyDescriptor
} from '../../src/lib/server/assessments/contract/bank.ts';
import { SPECIALIZATION_KEYS, type SpecializationKey } from '../../src/lib/server/assessments/contract/catalog.ts';
import {
	GATE_SOURCES_FILE as GATE_SOURCES_NAME,
	gateSourceSha256 as familyGateSourceSha256
} from '../../src/lib/server/assessments/families.ts';
import { sharedClosureSha256 } from '../../src/lib/server/assessments/shared-code.ts';

export const FAMILIES_DIR = fileURLToPath(new URL('../../assessments/families/', import.meta.url));
export const DESCRIPTOR_FILE = 'descriptor.json';
export const GENERATOR_FILE = 'generator.ts';
/** The factory's record of the source each family last passed the gates with (`gate-sources.json`). */
export const GATE_SOURCES_FILE = join(FAMILIES_DIR, GATE_SOURCES_NAME);

export interface TreeFamily {
	specialization: SpecializationKey;
	key: string;
	dir: string;
	/** A probe is gated but never part of a release. */
	probe: boolean;
	descriptor: FamilyDescriptor;
	/** The generator, imported on first use: a family under work breaks only its own check. */
	module: () => Promise<FactoryModule>;
}

function familyDirs(base: string): string[] {
	if (!existsSync(base)) return [];
	return readdirSync(base)
		.filter((name) => !name.startsWith('_') && !name.startsWith('.') && statSync(join(base, name)).isDirectory())
		.sort();
}

/** The descriptor of a family directory, or why it cannot be read. */
function load(specialization: SpecializationKey, dir: string, probe: boolean): TreeFamily | string {
	const key = dir.split('/').at(-1) ?? '';
	let descriptor: FamilyDescriptor;
	try {
		descriptor = JSON.parse(readFileSync(join(dir, DESCRIPTOR_FILE), 'utf8')) as FamilyDescriptor;
	} catch (error) {
		return `${specialization}/${key}: ${DESCRIPTOR_FILE} cannot be read: ${(error as Error).message}`;
	}
	if (descriptor.key !== key || descriptor.specialization !== specialization)
		return `${specialization}/${key}: the descriptor names ${descriptor.specialization}/${descriptor.key}`;
	if (!existsSync(join(dir, GENERATOR_FILE))) return `${specialization}/${key}: no ${GENERATOR_FILE}`;
	let cached: Promise<FactoryModule> | null = null;
	const module = (): Promise<FactoryModule> =>
		(cached ??= import(pathToFileURL(join(dir, GENERATOR_FILE)).href).then((loaded: Partial<FactoryModule>) => {
			if (typeof loaded.build !== 'function')
				throw new Error(`${specialization}/${key}: ${GENERATOR_FILE} exports no build()`);
			return { build: loaded.build };
		}));
	return { specialization, key, dir, probe, descriptor, module };
}

/**
 * Every family of the tree and every probe, specialization by specialization, keys in order; a directory whose
 * descriptor cannot be read is a problem of the tree, listed apart.
 */
export function loadTree(): { families: TreeFamily[]; problems: string[] } {
	const families: TreeFamily[] = [];
	const problems: string[] = [];
	const add = (loaded: TreeFamily | string): void => {
		if (typeof loaded === 'string') problems.push(loaded);
		else families.push(loaded);
	};
	for (const specialization of SPECIALIZATION_KEYS) {
		for (const name of familyDirs(join(FAMILIES_DIR, specialization)))
			add(load(specialization, join(FAMILIES_DIR, specialization, name), false));
		for (const name of familyDirs(join(FAMILIES_DIR, '_probes', specialization)))
			add(load(specialization, join(FAMILIES_DIR, '_probes', specialization, name), true));
	}
	return { families, problems };
}

/**
 * The hash reviews and Angoff ratings are made on (contract `familySourceSha256`): the descriptor without its gate
 * report and ratings, plus the text of `generator.ts`. Read from disk, so it is the family as it is now.
 */
export function currentSourceSha256(family: Pick<TreeFamily, 'dir'>): string {
	const descriptor = JSON.parse(readFileSync(join(family.dir, DESCRIPTOR_FILE), 'utf8')) as FamilyDescriptor;
	return contractFamilySourceSha256(descriptor, readFileSync(join(family.dir, GENERATOR_FILE), 'utf8'));
}

/** The source a gate run checked (`gateSourceSha256` of the bank loader, which the release checks it against). */
export function gateSourceSha256(family: Pick<TreeFamily, 'dir'>): string {
	const shared = sharedClosureSha256(FAMILIES_DIR, [join(family.dir, GENERATOR_FILE)]);
	return familyGateSourceSha256(currentSourceSha256(family), shared);
}

/**
 * The shared code a release of the specialization records as `sharedSha256`: the import closure of its generators, the
 * same hash the engine checks before serving (`sharedCodeSha256`).
 */
export function sharedSha256(families: readonly Pick<TreeFamily, 'dir'>[]): string {
	return sharedClosureSha256(
		FAMILIES_DIR,
		families.map((f) => join(f.dir, GENERATOR_FILE))
	);
}

/** `gate-sources.json`: key → `gateSourceSha256` of the last passed gate run. */
export function readGateSources(): Record<string, string> {
	if (!existsSync(GATE_SOURCES_FILE)) return {};
	return JSON.parse(readFileSync(GATE_SOURCES_FILE, 'utf8')) as Record<string, string>;
}
