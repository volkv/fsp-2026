// The evidence a reader counts is the run in force (docs/domain.md, 12.1, 17.3): the published run while its input is at
// or above the candidate's evidence floor. A withdrawal raises the floor in its own transaction, before the run is
// blocked and recomputed; from that moment the run's FSP levels stop counting in the operator's career funnel and its
// skills in the feedback «market ↔ FSP». The category comes from a test and does not rest on the run: it stays. The
// world is written straight into the tables, and the withdrawal only raises the floor, leaving the run `published`.
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	candidates,
	categorizationRulesets,
	evidenceRuns,
	fspLevelAssignments,
	invitations,
	invitationTerms,
	productPolicies,
	skillInferences,
	sourceFacts
} from '$lib/server/db/schema';
import { careerFunnel } from '$lib/server/hiring/funnel';
import { uuidv7 } from '$lib/server/ids';
import { skillFeedback } from '$lib/server/operator/skills-feedback';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createTaxonomyVersion,
	randomSha256,
	offerTermsRow
} from '../helpers/factories';

const DAY = 86_400_000;
const NOW = new Date();

const operator: AccessSubject = {
	userId: uuidv7(),
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: true, admin: false, extraPermissions: [] }
};

let database: TestDatabase;
let world: {
	taxonomyVersionId: string;
	rulesetId: string;
	invitationPolicyId: string;
	companyId: string;
	memberId: string;
	vacancyId: string;
};

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	const taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	const [ruleset] = await db
		.insert(categorizationRulesets)
		.values({ version: 1, taxonomyVersionId, params: {} })
		.returning({ id: categorizationRulesets.id });
	const since = new Date(NOW.getTime() - 400 * DAY);
	const [invitationPolicy] = await db
		.insert(productPolicies)
		.values([
			{
				kind: 'invitation_policy',
				version: 1,
				params: {
					response_window_hours: 72,
					decline_reason_codes: ['other'],
					reason_required: true,
					max_open_per_company_per_day: 50,
					reopen_cooldown_days: 14,
					max_reopens: 2
				},
				effectiveFrom: since
			},
			{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 1 }, effectiveFrom: since }
		])
		.returning({ id: productPolicies.id });
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	if (!ruleset || !invitationPolicy) throw new Error('world not set up');
	world = {
		taxonomyVersionId,
		rulesetId: ruleset.id,
		invitationPolicyId: invitationPolicy.id,
		companyId: company.id,
		memberId: member.id,
		vacancyId: (
			await createOwnVacancy(
				db,
				{ companyId: company.id, memberId: member.id, taxonomyVersionId },
				{ requiredSkillKeys: ['go'], publishedAt: NOW }
			)
		).id
	};
});

afterAll(async () => {
	await database.drop();
});

/**
 * A backend developer confirmed by a test, with a published run resting on an FSP result, invited by the company of
 * the world.
 */
async function invitedDeveloper(resultStatus: 'official' | 'preliminary' = 'official') {
	const { db } = database;
	const person = await createCandidate(db, { profileRevision: 1 });
	const [fact] = await db
		.insert(sourceFacts)
		.values({
			candidateId: person.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: { result: { status: resultStatus } },
			payloadSha256: randomSha256(),
			observedAt: NOW,
			lastVerifiedAt: NOW,
			status: 'active'
		})
		.returning({ id: sourceFacts.id });
	if (!fact) throw new Error('fact not inserted');
	const [run] = await db
		.insert(evidenceRuns)
		.values({
			candidateId: person.id,
			inputRevision: 1,
			inputSnapshotSha256: randomSha256(),
			inputRefs: { facts: [fact.id], claims: [] },
			taxonomyVersionId: world.taxonomyVersionId,
			rulesetId: world.rulesetId,
			asOf: NOW,
			computedAt: NOW,
			experienceSummary: {},
			status: 'published'
		})
		.returning({ id: evidenceRuns.id });
	if (!run) throw new Error('run not inserted');
	await db
		.insert(fspLevelAssignments)
		.values({ runId: run.id, discipline: 'product', level: 'L2', basisFactIds: [fact.id] });
	await decide(db, person.id, { specialization: 'backend', grade: 'middle' });
	await db.insert(skillInferences).values({
		runId: run.id,
		candidateId: person.id,
		skillKey: 'go',
		strength: '0.800',
		strengthBand: 'strong',
		attestation: 'direct',
		badgeTrust: 'fsp_verified',
		contributions: [{ fact_id: fact.id, source: 'fsp', attestation: 'direct' }]
	});
	const invitationId = uuidv7();
	const termsId = uuidv7();
	const sentAt = new Date(NOW.getTime() - 10 * DAY);
	await db.transaction(async (tx) => {
		await tx.insert(invitations).values({
			id: invitationId,
			companyId: world.companyId,
			candidateId: person.id,
			sentByMemberId: world.memberId,
			status: 'sent',
			currentTermsId: termsId,
			policyId: world.invitationPolicyId,
			sentAt
		});
		await tx.insert(invitationTerms).values({
			id: termsId,
			invitationId,
			version: 1,
			...offerTermsRow(),
			salaryMin: 200_000,
			salaryMax: 300_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			responseDueAt: new Date(sentAt.getTime() + 3 * DAY),
			createdByMemberId: world.memberId,
			createdAt: sentAt
		});
	});
	return person;
}

/** What the withdrawal transaction does first (domain 17.3): revision and floor up, the run still `published`. */
async function raiseFloor(candidateId: string) {
	await database.db
		.update(candidates)
		.set({
			profileRevision: sql`${candidates.profileRevision} + 1`,
			evidenceFloorRevision: sql`${candidates.profileRevision} + 1`
		})
		.where(eq(candidates.id, candidateId));
}

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

describe('a run below the evidence floor', () => {
	it('stops counting in the funnel and the feedback, while the category stays', async () => {
		await invitedDeveloper();
		const withdrawn = await invitedDeveloper();
		const invitedBy = async (dimension: 'fsp_level' | 'specialization') =>
			Object.fromEntries(
				(
					await careerFunnel({ db: database.db, crypto, now: () => NOW }, operator, {
						dimensions: [dimension]
					})
				).groups.map((group) => [group.key, group.invited])
			);
		const fspCandidates = async () =>
			(await skillFeedback(database.db, operator, { windowDays: 90, now: NOW, threshold: 1 })).fspCandidates;

		expect(await invitedBy('fsp_level')).toEqual({ L2: { value: 2 } });
		expect(await invitedBy('specialization')).toEqual({ backend: { value: 2 } });
		expect(await fspCandidates()).toEqual({ value: 2 });

		await raiseFloor(withdrawn.id);

		expect(await invitedBy('fsp_level')).toEqual({ L2: { value: 1 }, none: { value: 1 } });
		expect(await invitedBy('specialization')).toEqual({ backend: { value: 2 } });
		expect(await fspCandidates()).toEqual({ value: 1 });

		// A preliminary result is not a result yet: the feedback counts «с ФСП» by the catalog's definition.
		await invitedDeveloper('preliminary');
		expect(await fspCandidates()).toEqual({ value: 1 });
	});
});
