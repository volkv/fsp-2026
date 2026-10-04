// `categorize` of the bridge: the product's categorization over profile snapshots the harness passes in (from `extract`),
// optionally with FSP achievements in the wire format of the source, with the rule set and taxonomy of the checkout.
// Achievements go the synchronization's way (src/lib/server/fsp/sync.ts): the page is read by the adapter's schema, the
// active records become `fsp_verified` facts and the projection rules give their claims. The answer is the part the
// quality metrics compare: the outcome, each assignment's role, grade range and stack, the FSP levels and the codes of
// what is missing.
import { z } from 'zod';
import { categorize } from '$lib/server/categorization/categorize';
import type {
	CategorizationSnapshot,
	ClaimInput,
	FactInput,
	FspLevel,
	RulesContext
} from '$lib/server/categorization/types';
import { factClaims, snapshotFacts, type FactDraft, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import { achievementsPageSchema } from '$lib/server/fsp/schema';

const nullableString = z.string().nullable();

/** `CategorizationSnapshot`, validated: it crosses the process boundary as JSON. */
export const snapshotSchema: z.ZodType<CategorizationSnapshot> = z.strictObject({
	candidateId: z.string().min(1),
	revision: z.int().nonnegative(),
	desiredRoleKeys: z.array(z.string()),
	facts: z.array(
		z.strictObject({
			id: z.string().min(1),
			source: z.enum(['fsp', 'platform_test', 'codeforces', 'github', 'resume', 'self_declared']),
			factType: z.string().min(1),
			sourceRecordRef: z.string().min(1),
			eventKey: nullableString,
			trustLevel: z.enum(['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed']),
			occurredOn: nullableString,
			payload: z.unknown()
		})
	),
	claims: z.array(
		z.strictObject({
			id: z.string().min(1),
			factId: z.string().min(1),
			claimType: z.string().min(1),
			extractor: z.enum(['rules', 'model', 'source_mapping']),
			skillKey: nullableString,
			eventKey: nullableString,
			polarity: z.enum(['asserted', 'negated', 'uncertain']),
			candidateReview: z.enum(['pending', 'confirmed']),
			experienceEntryId: nullableString,
			value: z.unknown()
		})
	),
	experience: z.array(
		z.strictObject({
			id: z.string().min(1),
			factId: z.string().min(1),
			roleKey: nullableString,
			periodFrom: nullableString,
			periodTo: nullableString,
			periodFromPrecision: z.enum(['month', 'year']).nullable(),
			periodToPrecision: z.enum(['month', 'year']).nullable(),
			isCurrent: z.boolean(),
			appliedSkillKeys: z.array(z.string()),
			periodStatus: z.enum(['valid', 'missing', 'invalid']),
			candidateReview: z.enum(['pending', 'confirmed', 'edited'])
		})
	)
});

/** One page of `fsp-achievements/v1` holding the whole record of an athlete. */
export const fspPageSchema = achievementsPageSchema.refine(
	(page) => page.page.totalPages === 1 && page.complete === true,
	'the record of an athlete is one complete page'
);

export type FspPage = z.output<typeof fspPageSchema>;

/** The facts of the page as the synchronization drafts them from the athlete's snapshot. */
export function pageFacts(page: FspPage): FactDraft[] {
	return snapshotFacts({
		athlete: page.athlete,
		qualifications: page.qualifications,
		results: page.results,
		competitions: page.competitions,
		generatedAt: page.generatedAt,
		completeness: { complete: true, sourceVersion: page.sourceVersion, pages: { fetched: 1, total: 1 } }
	});
}

/**
 * The facts and claims FSP achievements add to a snapshot, as the synchronization stores them: only active records,
 * trust `fsp_verified`, claims of the projection rules by `source_mapping`, asserted and not reviewed.
 */
export function fspEvidence(
	page: FspPage,
	projection: ProjectionTaxonomy,
	idPrefix: string
): { facts: FactInput[]; claims: ClaimInput[] } {
	const drafts = pageFacts(page);
	const facts: FactInput[] = [];
	const claims: ClaimInput[] = [];
	drafts.forEach((draft, index) => {
		if (draft.status !== 'active') return;
		const factId = `${idPrefix}:fsp:${String(index).padStart(3, '0')}`;
		facts.push({
			id: factId,
			source: 'fsp',
			factType: draft.factType,
			sourceRecordRef: draft.sourceRecordRef,
			eventKey: draft.eventKey,
			trustLevel: 'fsp_verified',
			occurredOn: draft.occurredOn,
			payload: draft.payload
		});
		factClaims(draft, page.athlete.birthYear, projection).forEach((claim, claimIndex) => {
			claims.push({
				id: `${factId}:c${String(claimIndex).padStart(3, '0')}`,
				factId,
				claimType: claim.claimType,
				extractor: 'source_mapping',
				skillKey: claim.skillKey,
				eventKey: null,
				polarity: 'asserted',
				candidateReview: 'pending',
				experienceEntryId: null,
				value: claim.value
			});
		});
	});
	return { facts, claims };
}

/** The snapshot with the achievements added. */
export function withFsp(
	snapshot: CategorizationSnapshot,
	page: FspPage,
	projection: ProjectionTaxonomy
): CategorizationSnapshot {
	const added = fspEvidence(page, projection, snapshot.candidateId);
	return { ...snapshot, facts: [...snapshot.facts, ...added.facts], claims: [...snapshot.claims, ...added.claims] };
}

export interface CategorizedProfile {
	id: string;
	outcome: 'complete' | 'partial' | 'insufficient_data';
	assignments: {
		rank: 'primary' | 'secondary';
		role_status: 'established' | 'insufficient_data';
		role_key: string | null;
		score: number | null;
		grade_status: 'established' | 'insufficient_data';
		grade_min: string | null;
		grade_max: string | null;
		stack_status: 'established' | 'insufficient_data';
		stack_skill_keys: string[];
	}[];
	missing: { role: string[]; grade: string[]; stack: string[] };
	fsp_levels: { discipline: string; level: FspLevel }[];
}

export function categorizeProfile(
	id: string,
	snapshot: CategorizationSnapshot,
	rules: RulesContext,
	asOf: Date
): CategorizedProfile {
	const result = categorize(snapshot, rules, asOf);
	return {
		id,
		outcome: result.outcome,
		assignments: result.assignments.map((a) => ({
			rank: a.rank,
			role_status: a.roleStatus,
			role_key: a.roleKey,
			score: a.score,
			grade_status: a.gradeStatus,
			grade_min: a.gradeMin,
			grade_max: a.gradeMax,
			stack_status: a.stackStatus,
			stack_skill_keys: a.stackSkillKeys
		})),
		missing: {
			role: result.missing.role.map((m) => m.code),
			grade: result.missing.grade.map((m) => m.code),
			stack: result.missing.stack.map((m) => m.code)
		},
		fsp_levels: result.fspLevels.map((l) => ({ discipline: l.discipline, level: l.level }))
	};
}
