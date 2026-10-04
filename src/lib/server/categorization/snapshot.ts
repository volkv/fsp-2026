// Input of a run read from the database (docs/domain.md 12.1): the latest rule set with its taxonomy version, and one
// consistent snapshot of the candidate's active facts, claims and experience entries at the current profile revision.
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Executor } from '$lib/server/db';
import {
	candidates,
	categorizationRulesets,
	claims,
	experienceEntries,
	fspLevelRules,
	grades,
	roles,
	skills,
	sourceFacts,
	taxonomyVersions
} from '$lib/server/db/schema';
import { canonicalJson } from '$lib/server/json/canonical';
import { categorizationParamsSchema } from './params';
import type { CategorizationSnapshot, LevelCriterion, RulesContext } from './types';

/** The latest rule set cannot be read by this calculation: a rule set version it does not know. */
export class RulesetUnsupported extends Error {
	override name = 'RulesetUnsupported';
}

const levelCriterion: z.ZodType<LevelCriterion> = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('rank'),
		minRank: z.string(),
		basis: z.array(z.enum(['qualification', 'evsk_indicator'])).min(1)
	}),
	z.strictObject({ kind: z.literal('national_team'), squads: z.array(z.enum(['main', 'reserve'])).min(1) }),
	z.strictObject({ kind: z.literal('participation'), resultStatuses: z.array(z.literal('official')).min(1) })
]);
const levelCriteria = z.strictObject({ anyOf: z.array(levelCriterion).min(1) });
const coreSkillGroups = z.array(z.array(z.string()).min(1));

/** Rules of one rule set and its taxonomy version. */
async function rulesContextOf(
	executor: Executor,
	ruleset: typeof categorizationRulesets.$inferSelect
): Promise<RulesContext> {
	const parsed = categorizationParamsSchema.safeParse(ruleset.params);
	if (!parsed.success) {
		throw new RulesetUnsupported(
			`categorization rule set version ${ruleset.version} does not match the parameters this calculation reads`
		);
	}
	const versionId = ruleset.taxonomyVersionId;
	const [version] = await executor
		.select({ label: taxonomyVersions.label })
		.from(taxonomyVersions)
		.where(eq(taxonomyVersions.id, versionId));
	if (!version) throw new Error(`taxonomy version ${versionId} of rule set ${ruleset.version} is missing`);
	const [roleRows, skillRows, gradeRows, levelRows] = await Promise.all([
		executor.select().from(roles).where(eq(roles.taxonomyVersionId, versionId)),
		executor
			.select({ key: skills.key, kind: skills.kind, parentKey: skills.parentKey })
			.from(skills)
			.where(eq(skills.taxonomyVersionId, versionId)),
		executor
			.select({ key: grades.key, ordinal: grades.ordinal })
			.from(grades)
			.where(eq(grades.taxonomyVersionId, versionId)),
		executor.select().from(fspLevelRules).where(eq(fspLevelRules.taxonomyVersionId, versionId))
	]);
	const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
	return {
		taxonomyVersionId: versionId,
		taxonomyLabel: version.label,
		rulesetId: ruleset.id,
		rulesetVersion: ruleset.version,
		params: parsed.data,
		roles: roleRows
			.map((r) => ({
				key: r.key,
				family: r.family,
				coreSkillGroups: coreSkillGroups.parse(r.coreSkillGroups),
				typicalSkills: r.typicalSkills
			}))
			.sort(byKey),
		skills: skillRows.sort(byKey),
		grades: gradeRows.sort((a, b) => a.ordinal - b.ordinal),
		fspLevelRules: levelRows
			.map((r) => ({ level: r.level, criteria: levelCriteria.parse(r.criteria) }))
			.sort((a, b) => (a.level < b.level ? -1 : 1))
	};
}

/** The rule set with the highest version whose taxonomy version is published; `null` before the first release. */
export async function loadLatestRules(executor: Executor): Promise<RulesContext | null> {
	const [row] = await executor
		.select({ ruleset: categorizationRulesets })
		.from(categorizationRulesets)
		.innerJoin(taxonomyVersions, eq(taxonomyVersions.id, categorizationRulesets.taxonomyVersionId))
		.where(eq(taxonomyVersions.status, 'published'))
		.orderBy(desc(categorizationRulesets.version))
		.limit(1);
	return row ? rulesContextOf(executor, row.ruleset) : null;
}

/** The rules a stored run was computed with. */
export async function loadRulesById(executor: Executor, rulesetId: string): Promise<RulesContext> {
	const [ruleset] = await executor
		.select()
		.from(categorizationRulesets)
		.where(eq(categorizationRulesets.id, rulesetId));
	if (!ruleset) throw new Error(`rule set ${rulesetId} is missing`);
	return rulesContextOf(executor, ruleset);
}

export interface LoadedSnapshot {
	snapshot: CategorizationSnapshot;
	evidenceFloorRevision: number;
}

const COUNTED_STATUSES = ['onboarding', 'active', 'ineligible_age'] as const;

/**
 * One consistent snapshot at the current profile revision, read in a repeatable-read transaction: the revision and
 * the evidence it covers come from the same moment. `null` — the candidate is gone or being deleted.
 */
export async function loadSnapshot(db: Database, candidateId: string): Promise<LoadedSnapshot | null> {
	return db.transaction(
		async (tx) => {
			const [candidate] = await tx
				.select({
					revision: candidates.profileRevision,
					floor: candidates.evidenceFloorRevision,
					status: candidates.status,
					desiredRoleKeys: candidates.desiredRoleKeys
				})
				.from(candidates)
				.where(eq(candidates.id, candidateId));
			if (!candidate || !(COUNTED_STATUSES as readonly string[]).includes(candidate.status)) return null;

			const factRows = await tx
				.select({
					id: sourceFacts.id,
					source: sourceFacts.source,
					factType: sourceFacts.factType,
					sourceRecordRef: sourceFacts.sourceRecordRef,
					eventKey: sourceFacts.eventKey,
					trustLevel: sourceFacts.trustLevel,
					occurredOn: sourceFacts.occurredOn,
					payload: sourceFacts.payload
				})
				.from(sourceFacts)
				.where(and(eq(sourceFacts.candidateId, candidateId), eq(sourceFacts.status, 'active')))
				.orderBy(sourceFacts.id);
			const claimRows = await tx
				.select({
					id: claims.id,
					factId: claims.factId,
					claimType: claims.claimType,
					extractor: claims.extractor,
					skillKey: claims.skillKey,
					eventKey: claims.eventKey,
					polarity: claims.polarity,
					candidateReview: claims.candidateReview,
					experienceEntryId: claims.experienceEntryId,
					value: claims.value
				})
				.from(claims)
				.innerJoin(sourceFacts, eq(sourceFacts.id, claims.factId))
				.where(
					and(
						eq(claims.candidateId, candidateId),
						eq(claims.status, 'active'),
						ne(claims.candidateReview, 'rejected'),
						eq(sourceFacts.status, 'active')
					)
				)
				.orderBy(claims.id);
			const experienceRows = await tx
				.select({
					id: experienceEntries.id,
					factId: experienceEntries.factId,
					roleKey: experienceEntries.roleKey,
					periodFrom: experienceEntries.periodFrom,
					periodTo: experienceEntries.periodTo,
					periodFromPrecision: experienceEntries.periodFromPrecision,
					periodToPrecision: experienceEntries.periodToPrecision,
					isCurrent: experienceEntries.isCurrent,
					appliedSkillKeys: experienceEntries.appliedSkillKeys,
					periodStatus: experienceEntries.periodStatus,
					candidateReview: experienceEntries.candidateReview
				})
				.from(experienceEntries)
				.innerJoin(sourceFacts, eq(sourceFacts.id, experienceEntries.factId))
				.where(
					and(
						eq(experienceEntries.candidateId, candidateId),
						eq(experienceEntries.status, 'active'),
						ne(experienceEntries.candidateReview, 'rejected'),
						eq(sourceFacts.status, 'active')
					)
				)
				.orderBy(experienceEntries.id);

			return {
				evidenceFloorRevision: candidate.floor,
				snapshot: {
					candidateId,
					revision: candidate.revision,
					desiredRoleKeys: candidate.desiredRoleKeys,
					facts: factRows,
					claims: claimRows.map((c) => {
						if (c.candidateReview === 'rejected') throw new Error('a rejected claim passed the filter');
						return { ...c, candidateReview: c.candidateReview };
					}),
					experience: experienceRows.map((e) => {
						if (e.candidateReview === 'rejected') throw new Error('a rejected entry passed the filter');
						return { ...e, candidateReview: e.candidateReview };
					})
				}
			};
		},
		{ isolationLevel: 'repeatable read', accessMode: 'read only' }
	);
}

/** SHA-256 of the canonical snapshot (`categorization_runs.input_snapshot_sha256`). */
export function snapshotSha256(snapshot: CategorizationSnapshot): string {
	return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}

/** Identifiers of the facts, claims and experience entries the snapshot holds (`categorization_runs.input_refs`). */
export function inputRefs(snapshot: CategorizationSnapshot) {
	return {
		facts: snapshot.facts.map((f) => f.id),
		claims: snapshot.claims.map((c) => c.id),
		experience_entries: snapshot.experience.map((e) => e.id)
	};
}

/** Whether every fact and claim of a snapshot is still active: a removed ground makes a result stale. */
export async function inputsStillActive(executor: Executor, snapshot: CategorizationSnapshot): Promise<boolean> {
	const factIds = snapshot.facts.map((f) => f.id);
	const claimIds = snapshot.claims.map((c) => c.id);
	if (factIds.length > 0) {
		const active = await executor
			.select({ id: sourceFacts.id })
			.from(sourceFacts)
			.where(and(inArray(sourceFacts.id, factIds), eq(sourceFacts.status, 'active')));
		if (active.length !== factIds.length) return false;
	}
	if (claimIds.length > 0) {
		const active = await executor
			.select({ id: claims.id })
			.from(claims)
			.where(and(inArray(claims.id, claimIds), eq(claims.status, 'active'), ne(claims.candidateReview, 'rejected')));
		if (active.length !== claimIds.length) return false;
	}
	return true;
}
