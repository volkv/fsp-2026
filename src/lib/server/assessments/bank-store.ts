// Released banks as the engine serves them (docs/domain.md, 10.5): the release in force of a specialization, the open
// specializations, and the generator of a family — loaded from the bank tree and checked against the hash the release
// recorded, so an attempt is never served by code the release was not checked with.
import { resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { bankReleases } from '$lib/server/db/schema';
import {
	CATALOG,
	PRACTICE_LANGUAGE_SKILLS,
	SPECIALIZATION_KEYS,
	specializationOpen,
	type GradeKey,
	type SpecializationKey
} from './contract/catalog';
import type { FamilyModule, Reviewer } from './contract/bank';
import type { TrajectoryReport } from './contract/validate';
import { loadFamily, sharedCodeSha256 } from './families';
import type { GradeJudgement, ManifestFamily, ReleaseManifest } from './release';

/** The bank tree next to the application: the repository in development, `/app` in the image. */
export const BANK_ROOT = resolve(process.cwd(), 'assessments/families');

export interface ServedRelease {
	id: string;
	specialization: SpecializationKey;
	sharedSha256: string;
	families: ManifestFamily[];
}

const isSpecialization = (value: string): value is SpecializationKey =>
	(SPECIALIZATION_KEYS as readonly string[]).includes(value);

const SERVED = {
	id: bankReleases.id,
	specialization: bankReleases.specialization,
	sharedSha256: bankReleases.sharedSha256,
	manifest: bankReleases.manifest
};

function served(row: { id: string; specialization: string; sharedSha256: string; manifest: unknown }): ServedRelease {
	if (!isSpecialization(row.specialization)) throw new Error(`release ${row.id} of unknown ${row.specialization}`);
	return {
		id: row.id,
		specialization: row.specialization,
		sharedSha256: row.sharedSha256,
		families: (row.manifest as ReleaseManifest).families
	};
}

/** The release in force of a specialization; `null` — the bank of it is not released. */
export async function releaseInForce(
	executor: Executor,
	specialization: SpecializationKey
): Promise<ServedRelease | null> {
	const [row] = await executor
		.select(SERVED)
		.from(bankReleases)
		.where(and(eq(bankReleases.specialization, specialization), eq(bankReleases.status, 'released')));
	return row ? served(row) : null;
}

/** A release by its id, retired or not: an attempt keeps the release it started on. */
export async function releaseById(executor: Executor, id: string): Promise<ServedRelease> {
	const [row] = await executor.select(SERVED).from(bankReleases).where(eq(bankReleases.id, id));
	if (!row) throw new Error(`release ${id} is missing`);
	return served(row);
}

/** Specializations with a bank release in status `released` (domain 10.5). */
export async function releasedSpecializations(executor: Executor): Promise<Set<SpecializationKey>> {
	const rows = await executor
		.select({ specialization: bankReleases.specialization })
		.from(bankReleases)
		.where(eq(bankReleases.status, 'released'));
	return new Set(rows.map((r) => r.specialization).filter(isSpecialization));
}

/** Specializations open now: switched on in the catalog and with a released bank (`specializationOpen`). */
export async function openSpecializations(executor: Executor): Promise<Set<SpecializationKey>> {
	const released = await releasedSpecializations(executor);
	return new Set(SPECIALIZATION_KEYS.filter((s) => specializationOpen(s, released)));
}

export class GeneratorMismatch extends Error {
	constructor(what: string) {
		super(`${what} on disk is not the one its release was checked with`);
		this.name = 'GeneratorMismatch';
	}
}

const modules = new Map<string, Promise<FamilyModule>>();

/**
 * The generator of a family of a release, from the bank tree, checked against the hashes the release recorded: of the
 * generator itself and of the shared code it may import.
 */
export function familyModule(
	family: ManifestFamily,
	release: Pick<ServedRelease, 'specialization' | 'sharedSha256'>,
	root: string = BANK_ROOT
): Promise<FamilyModule> {
	const { descriptor } = family;
	const key = `${root}|${descriptor.specialization}/${descriptor.key}@${family.generatorSha256}+${release.sharedSha256}`;
	let loaded = modules.get(key);
	if (!loaded) {
		loaded = (async () => {
			if ((await sharedCodeSha256(root, release.specialization)) !== release.sharedSha256) {
				throw new GeneratorMismatch(`the shared code of ${release.specialization}`);
			}
			const found = await loadFamily(
				resolve(root, descriptor.specialization, descriptor.key),
				descriptor.specialization,
				descriptor.key
			);
			if (found.generatorSha256 !== family.generatorSha256) {
				throw new GeneratorMismatch(`the generator of ${descriptor.key}`);
			}
			return found.module;
		})();
		loaded.catch(() => modules.delete(key));
		modules.set(key, loaded);
	}
	return loaded;
}

/** Generators of the families of a release: the bank tree, or loaded modules the tests and the demo seed pass in. */
export type ModuleSource = (family: ManifestFamily, release: ServedRelease) => Promise<FamilyModule>;

export interface ConfirmingBlock {
	block: string;
	specialization: SpecializationKey;
	/** «Backend: Базы данных и SQL». */
	title: string;
}

/**
 * For each skill, the blocks of open specializations whose test confirms it (domain 12.4): the skills of a block passed,
 * and for the practice block the skills of its languages, confirmed when the practice gate is passed.
 */
export async function confirmingBlocks(
	executor: Executor,
	skillKeys: readonly string[]
): Promise<Map<string, ConfirmingBlock[]>> {
	const open = await openSpecializations(executor);
	const result = new Map<string, ConfirmingBlock[]>(skillKeys.map((key) => [key, []]));
	for (const block of CATALOG.blocks) {
		if (!open.has(block.specialization)) continue;
		const specialization = CATALOG.specializations.find((s) => s.key === block.specialization);
		const skills = block.practice
			? (specialization?.practiceLanguages ?? []).map((language) => PRACTICE_LANGUAGE_SKILLS[language])
			: block.skillKeys;
		for (const skill of new Set(skills)) {
			result.get(skill)?.push({
				block: block.code,
				specialization: block.specialization,
				title: `${specialization?.title ?? block.specialization}: ${block.title}`
			});
		}
	}
	return result;
}

/** The reviews and Angoff ratings of a family in a release, each marked whether it was made on the recorded sources. */
export interface FamilyJudgements {
	key: string;
	sourceSha256: string;
	rubricReviews: {
		reviewer: Reviewer;
		reviewedAt: string;
		verdict: 'approved' | 'changes_requested';
		remarks: readonly string[];
		onCurrentSources: boolean;
	}[];
	levels: {
		grade: GradeKey;
		round: 1 | 2;
		mean: number;
		ratings: { rater: Reviewer; p: number; ratedAt: string; onCurrentSources: boolean }[];
	}[];
}

export interface BankReleaseOverview {
	id: string;
	specialization: SpecializationKey;
	status: 'released' | 'retired';
	catalogVersion: string;
	procedureVersion: string;
	contentSha256: string;
	sharedSha256: string;
	releasedAt: Date;
	retiredAt: Date | null;
	families: number;
	levelsByBlock: Record<string, Record<string, number>>;
	anchors: Record<string, string[]>;
	capacity: {
		grade: GradeKey;
		scenario: string;
		ok: boolean;
		shortages: { step: string; position: number; block: string }[];
	}[];
	/** The engine's trajectory report the release passed (`TrajectoryReport` of the contract). */
	trajectories: TrajectoryReport | null;
	/** `judgementProvenance` of the family-levels by grade: how many rest on models only (domain 10.8). */
	judgement: Record<GradeKey, GradeJudgement>;
	reviews: FamilyJudgements[];
}

function familyJudgements(manifest: ReleaseManifest): FamilyJudgements[] {
	return manifest.families.map(({ descriptor }) => {
		const sourceSha256 = manifest.familySources[descriptor.key];
		if (sourceSha256 === undefined) throw new Error(`the manifest has no source hash of ${descriptor.key}`);
		return {
			key: descriptor.key,
			sourceSha256,
			rubricReviews: descriptor.gates.rubricReviews.map((review) => ({
				reviewer: review.reviewer,
				reviewedAt: review.reviewedAt,
				verdict: review.verdict,
				remarks: review.remarks,
				onCurrentSources: review.sourceSha256 === sourceSha256
			})),
			levels: descriptor.levels.map((level) => ({
				grade: level.grade,
				round: level.angoff.round,
				mean: level.angoff.mean,
				ratings: level.angoff.ratings.map((rating) => ({
					rater: rating.rater,
					p: rating.p,
					ratedAt: rating.ratedAt,
					onCurrentSources: rating.sourceSha256 === sourceSha256
				}))
			}))
		};
	});
}

/** Every release of the bank, newest first, with the reports of its manifest (contracts 10.3). */
export async function bankReleasesOverview(executor: Executor): Promise<BankReleaseOverview[]> {
	const rows = await executor.select().from(bankReleases).orderBy(desc(bankReleases.releasedAt));
	return rows.map((row) => {
		const manifest = row.manifest as ReleaseManifest;
		return {
			id: row.id,
			specialization: served(row).specialization,
			status: row.status,
			catalogVersion: row.catalogVersion,
			procedureVersion: row.procedureVersion,
			contentSha256: row.contentSha256,
			sharedSha256: row.sharedSha256,
			releasedAt: row.releasedAt,
			retiredAt: row.retiredAt,
			families: manifest.families.length,
			levelsByBlock: manifest.levelsByBlock,
			anchors: manifest.anchors,
			capacity: manifest.capacityChecks.map((check) => ({
				grade: check.grade,
				scenario: check.scenario.join('→'),
				ok: check.ok,
				shortages: check.shortages
			})),
			trajectories: manifest.trajectories,
			judgement: manifest.judgement,
			reviews: familyJudgements(manifest)
		};
	});
}
