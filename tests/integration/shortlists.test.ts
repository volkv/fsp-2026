// Shortlists of hiring needs (docs/domain.md, section 13.10): a need gives a shortlist of the candidates of its
// categories, ranked in two levels with reasons; a refinement is a new step and loses neither the shortlist nor its
// marks; every opening shows a candidate only through `canShow`; «what if» names who enters and leaves and why, and
// the range only by the intervals of a fixed cohort of a day; the blind comparison with a keyword search keeps its
// judgement without naming candidates. A query never holds a candidate id.
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { gradeDefinition, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import {
	categorizationRulesets,
	consentEvents,
	evidenceRuns,
	productPolicies,
	salaryCohortSnapshots,
	shortlistEvaluations,
	shortlistMarks,
	shortlistRevisions,
	skillInferences,
	sourceFacts,
	taxonomyVersions
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import { fail } from '$lib/server/ml/result';
import { createNeed, type NeedDeps } from '$lib/server/needs/service';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { offerTermsOfNeed, whyYouFromShortlist } from '$lib/server/invitations/offer-form';
import { createInvitation } from '$lib/server/invitations/send';
import { shortlistMatchOf } from '$lib/server/shortlists/service';
import { invitations, invitationTerms } from '$lib/server/db/schema';
import { offerTerms } from '../helpers/factories';
import { evaluationSummary, judgeEvaluation, startEvaluation } from '$lib/server/shortlists/evaluation';
import {
	createShortlist,
	markCandidate,
	openShortlist,
	reviseShortlist,
	unmarkCandidate,
	whatIf,
	type ShortlistDeps
} from '$lib/server/shortlists/service';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { declareGrade, releaseFixtureBank } from '../helpers/bank';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createCompany, createMember, createPublishedDocument } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;
const meta = { requestId: 'test-shortlists', ip: '127.0.0.1', userAgent: 'vitest' };

let database: TestDatabase;
let catalogDocumentId: string;
let taxonomyVersionId: string;
let categorizationRulesetId: string;

const modelsOff = {
	embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
	extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }))
};

let clock = () => new Date();
const deps = (): ShortlistDeps & MatchingDeps => ({
	db: database.db,
	models: modelsOff,
	pseudonym: (candidateId, companyId) =>
		createHash('sha256').update(`${candidateId}:${companyId}`).digest('hex').slice(0, 20),
	now: () => clock(),
	testResults: GRADE_DECISION_RESULTS
});
const needDeps = (): NeedDeps => ({ db: database.db, models: modelsOff, now: () => new Date() });

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const effectiveFrom = new Date(Date.now() - 10 * DAY);
	await database.db.insert(productPolicies).values([
		{
			kind: 'catalog_policy',
			version: 2,
			params: {
				small_count_threshold: 5,
				salary_bins: [
					{ until: 300_000, step: 25_000 },
					{ until: 600_000, step: 50_000 },
					{ until: null, step: 100_000 }
				]
			},
			effectiveFrom
		},
		{ kind: 'minor_policy', version: 1, params: { enabled: true, authority_methods: ['in_person'] }, effectiveFrom },
		{
			kind: 'invitation_policy',
			version: 1,
			params: {
				response_window_hours: 72,
				decline_reason_codes: ['salary', 'other'],
				reason_required: true,
				max_open_per_company_per_day: 50,
				reopen_cooldown_days: 14,
				max_reopens: 2
			},
			effectiveFrom
		},
		{ kind: 'notification_policy', version: 1, params: { response_due_reminder_hours: [24] }, effectiveFrom }
	]);
	// The specializations of the tests are open: their banks are released.
	for (const specialization of ['backend', 'frontend', 'qa', 'data_ml'] as const) {
		await releaseFixtureBank(database.db, specialization);
	}
	catalogDocumentId = (await createPublishedDocument(database.db, 'catalog_visibility', { publishedAt: effectiveFrom }))
		.id;
	const [version] = await database.db
		.select({ id: taxonomyVersions.id })
		.from(taxonomyVersions)
		.orderBy(desc(taxonomyVersions.publishedAt))
		.limit(1);
	const [ruleset] = await database.db.select({ id: categorizationRulesets.id }).from(categorizationRulesets).limit(1);
	if (!version || !ruleset) throw new Error('the taxonomy release was not published');
	taxonomyVersionId = version.id;
	categorizationRulesetId = ruleset.id;
});

afterAll(async () => {
	await database.drop();
});

async function employer() {
	const company = await createCompany(database.db, { status: 'verified' });
	const member = await createMember(database.db, company.id);
	if (!member.userId) throw new Error('member without user');
	const subject: AccessSubject = {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: company.id,
			role: 'recruiter',
			status: 'active',
			companyStatus: 'verified'
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { company, subject };
}

interface Person {
	category?: { specialization: SpecializationKey; grade: GradeKey };
	/** Blocks of the test of the category: margin per block in twentieths over four items. */
	margin?: number;
	skills?: { key: string; trust: 'fsp_verified' | 'claimed' }[];
	preferences?: Record<string, unknown>;
	fsp?: boolean;
}

/** A candidate in the catalog with a category confirmed by a test, its evidence and its result by blocks. */
async function person(setup: Person = {}) {
	const { db } = database;
	const row = await createCandidate(db, {
		visibility: 'catalog',
		preferences: setup.preferences ?? {},
		profileRevision: setup.category ? 0 : 1
	});
	await db.insert(consentEvents).values({
		subjectCandidateId: row.id,
		kind: 'catalog_visibility',
		documentId: catalogDocumentId,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: row.userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - DAY)
	});
	if (setup.category) {
		const margin = setup.margin ?? 0;
		const [first, second] = gradeDefinition(setup.category.specialization, setup.category.grade).defining;
		if (!first || !second) throw new Error('a grade has two defining blocks');
		// The sums of the defining blocks, as the engine records them with the decision.
		await decide(db, row.id, {
			...setup.category,
			blocks: [
				{ block: first, items: 4, score: 50 + margin, cut: 50 },
				{ block: second, items: 3, score: 40 + margin, cut: 40 }
			]
		});
	}
	if (setup.fsp || setup.skills) {
		const [fact] = await db
			.insert(sourceFacts)
			.values({
				candidateId: row.id,
				source: setup.fsp ? 'fsp' : 'resume',
				factType: setup.fsp ? 'competition_result' : 'resume_document',
				sourceRecordRef: `ref:${randomBytes(6).toString('hex')}`,
				trustLevel: setup.fsp ? 'fsp_verified' : 'claimed',
				ownershipBasis: setup.fsp ? 'operator_confirmed' : 'self_upload',
				payload: {},
				payloadSha256: randomBytes(32).toString('hex'),
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				status: 'active'
			})
			.returning();
		if (!fact) throw new Error('fact not inserted');
		const [current] = await db.execute<{ revision: string }>(
			sql`select profile_revision::text as revision from candidates where id = ${row.id}`
		);
		const [run] = await db
			.insert(evidenceRuns)
			.values({
				candidateId: row.id,
				inputRevision: Number(current?.revision ?? 1),
				inputSnapshotSha256: randomBytes(32).toString('hex'),
				inputRefs: { facts: [fact.id], claims: [] },
				taxonomyVersionId,
				rulesetId: categorizationRulesetId,
				asOf: new Date(),
				computedAt: new Date(),
				experienceSummary: {},
				status: 'published'
			})
			.returning();
		if (!run) throw new Error('run not inserted');
		if (setup.skills?.length) {
			await db.insert(skillInferences).values(
				setup.skills.map((skill) => ({
					runId: run.id,
					candidateId: row.id,
					skillKey: skill.key,
					strength: '0.800',
					strengthBand: 'strong' as const,
					attestation: skill.trust === 'fsp_verified' ? ('direct' as const) : ('claimed' as const),
					badgeTrust: skill.trust === 'fsp_verified' ? ('fsp_verified' as const) : null,
					contributions: [{ fact_id: fact.id, attestation: skill.trust === 'fsp_verified' ? 'direct' : 'claimed' }]
				}))
			);
		}
	}
	return row;
}

async function apiError(operation: Promise<unknown>): Promise<ApiError> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('the operation was expected to be refused');
}

const backendMiddle = { specialization: 'backend', grade: 'middle' } as const;
const backendJunior = { specialization: 'backend', grade: 'junior' } as const;
const frontendMiddle = { specialization: 'frontend', grade: 'middle' } as const;

async function backendNeed(subject: AccessSubject, form: Record<string, unknown> = {}) {
	return createNeed(needDeps(), subject, meta, {
		form: {
			specialization: 'backend',
			grade: { min: 'middle', max: 'middle' },
			skill_keys: ['sql', 'multithreading', 'kafka'],
			nice_skill_keys: [],
			...form
		}
	});
}

describe('a shortlist of a need', () => {
	it('ranks only the candidates of its categories, a confirmation above a claim, with reasons and their sources', async () => {
		const { subject } = await employer();
		const tested = await person({ category: backendMiddle, margin: 8 });
		const weaker = await person({ category: backendMiddle, margin: 0 });
		const claimsOnly = await person({
			category: backendMiddle,
			margin: 0,
			skills: [{ key: 'kafka', trust: 'claimed' }]
		});
		const withFsp = await person({
			category: backendMiddle,
			margin: 0,
			fsp: true,
			skills: [{ key: 'kafka', trust: 'fsp_verified' }]
		});
		const otherCategory = await person({ category: { specialization: 'qa', grade: 'middle' } });
		const uncategorized = await person({ skills: [{ key: 'kafka', trust: 'claimed' }] });

		const need = await backendNeed(subject);
		const created = await createShortlist(deps(), subject, meta, need.id, {});
		expect(created.revision).toBe(1);
		const view = await openShortlist(deps(), subject, created.id);
		const ids = view.items.map((item) => item.candidateId);
		expect(ids).not.toContain(otherCategory.id);
		expect(ids).not.toContain(uncategorized.id);
		// The FSP-confirmed Kafka covers every required skill: that group comes first. The others leave Kafka unconfirmed —
		// claimed, or unknown for a profile without a published evidence run; among them the claim is worth its band under
		// the ceiling, the stronger test wins among equals.
		expect(ids.slice(0, 4)).toEqual([withFsp.id, claimsOnly.id, tested.id, weaker.id]);
		expect(view.groups).toEqual({ covers: 1, gaps: 3, unconfirmed: 0 });
		const coverage = (id: string) => view.items.find((item) => item.candidateId === id)?.needMatch.coverage;
		expect(coverage(withFsp.id)).toEqual({ group: 'covers', required: 3, unconfirmed: [] });
		expect(coverage(claimsOnly.id)?.unconfirmed).toEqual([{ skill_key: 'kafka', state: 'claimed' }]);
		expect(coverage(tested.id)?.unconfirmed).toEqual([{ skill_key: 'kafka', state: 'unknown' }]);
		const first = view.items[0];
		if (!first) throw new Error('empty shortlist');
		expect(first.needMatch.reasons.length).toBeGreaterThanOrEqual(3);
		expect(first.needMatch.reasons.length).toBeLessThanOrEqual(5);
		expect(first.needMatch.reasons[0]).toMatchObject({
			code: 'skills_test',
			source: { kind: 'test_block', ref: 'be.db' }
		});
		// A company never sees internal fact ids.
		expect(JSON.stringify(first.needMatch)).not.toContain('fact_ids');
		// Without FSP the first one falls below the candidate whose Kafka is only claimed.
		expect(first.needMatch.positionWithoutFsp).toBeGreaterThan(1);
		expect(view.exposure.pool).toEqual({ withoutFsp: 3, of: 4 });
		expect(view.mode.reranker.status).toBe('not_applicable');
	});

	it('offers a neighbouring grade as a widening with its candidates, never takes it by default', async () => {
		const { subject } = await employer();
		const senior = await person({ category: { specialization: 'backend', grade: 'senior' } });
		const need = await backendNeed(subject, { skill_keys: ['sql'] });
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const view = await openShortlist(deps(), subject, id);
		expect(view.revision.query.categories).toEqual([backendMiddle]);
		expect(view.items.map((item) => item.candidateId)).not.toContain(senior.id);
		const above = view.coverage.neighbours.find((n) => n.specialization === 'backend' && n.grade === 'senior');
		expect(above?.direction).toBe('above');
		expect(above?.candidates).not.toEqual({ value: 0 });
		const widened = await reviseShortlist(deps(), subject, meta, id, {
			categories: [backendMiddle, { specialization: 'backend', grade: 'senior' }]
		});
		const after = await openShortlist(deps(), subject, id, { revision: widened.revision });
		expect(after.items.map((item) => item.candidateId)).toContain(senior.id);
		expect(after.coverage.neighbours.some((n) => n.grade === 'senior')).toBe(false);
	});

	it('of a fullstack need takes Backend, offers Frontend, and puts those confirmed in both first', async () => {
		const { subject } = await employer();
		// Interns: no other test of the file shares these categories.
		const backendIntern = { specialization: 'backend', grade: 'intern' } as const;
		const frontendIntern = { specialization: 'frontend', grade: 'intern' } as const;
		const strongBackend = await person({ category: backendIntern, margin: 8 });
		const both = await person({ category: backendIntern, margin: 0 });
		await decide(database.db, both.id, { specialization: 'frontend', grade: 'intern' });
		const frontendOnly = await person({ category: frontendIntern });
		const need = await createNeed(needDeps(), subject, meta, {
			form: {
				role_key: 'fullstack',
				grade: { min: 'intern', max: 'intern' },
				skill_keys: ['sql'],
				nice_skill_keys: []
			}
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const view = await openShortlist(deps(), subject, id);
		expect(view.revision.query.categories).toEqual([backendIntern]);
		const ids = view.items.map((item) => item.candidateId);
		expect(ids).not.toContain(frontendOnly.id);
		expect(ids.indexOf(both.id)).toBeLessThan(ids.indexOf(strongBackend.id));
		const match = (candidateId: string) => view.items.find((item) => item.candidateId === candidateId)?.needMatch;
		expect(match(both.id)?.composite).toMatchObject({ held: ['backend', 'frontend'], complete: true });
		expect(match(strongBackend.id)?.composite).toMatchObject({ held: ['backend'], complete: false });
		expect(view.coverage.composite.map((c) => `${c.specialization}:${c.grade}`)).toEqual(['frontend:intern']);
		const widened = await reviseShortlist(deps(), subject, meta, id, { categories: [backendIntern, frontendIntern] });
		const after = await openShortlist(deps(), subject, id, { revision: widened.revision });
		expect(after.items.map((item) => item.candidateId)).toContain(frontendOnly.id);
		expect(after.coverage.composite).toEqual([]);
	});

	it('of a need whose role no test checks is empty and says why, with categories its skills suggest', async () => {
		const { subject } = await employer();
		const need = await createNeed(needDeps(), subject, meta, {
			text: 'Дата-инженер\nТребования: Python, SQL, Hugging Face.\nБудет плюсом: dbt'
		});
		expect(need.form).toMatchObject({ role_key: 'data_engineer', other_skills: ['Hugging Face'] });
		expect(need.form.specialization).toBeUndefined();
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const view = await openShortlist(deps(), subject, id);
		expect(view.revision.query.categories).toEqual([]);
		expect(view.items).toEqual([]);
		expect(view.coverage).toMatchObject({
			basis: 'unsupported_role',
			roleKey: 'data_engineer',
			neighbours: []
		});
		expect(view.coverage.otherRequirements).toContainEqual({ name: 'Hugging Face', requirement: 'required' });
		expect(view.coverage.suggestions.length).toBeGreaterThan(0);
		expect(view.coverage.suggestions.every((c) => c.coveredSkills.length > 0)).toBe(true);
		// The suggestion is the employer's to take, as a refinement.
		const [suggested] = view.coverage.suggestions;
		if (!suggested) throw new Error('no suggestion');
		const revised = await reviseShortlist(deps(), subject, meta, id, {
			categories: [{ specialization: suggested.specialization, grade: suggested.grade }]
		});
		expect(revised.revision).toBe(2);
	});

	it('is refused for another company, and a candidate the company does not see cannot be marked', async () => {
		const { subject } = await employer();
		const need = await backendNeed(subject);
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const other = await employer();
		expect((await apiError(openShortlist(deps(), other.subject, id))).code).toBe('not_found');
		expect((await apiError(createShortlist(deps(), other.subject, meta, need.id, {}))).code).toBe('not_found');
		expect((await apiError(markCandidate(deps(), subject, meta, id, 'unknown-pseudonym', null))).code).toBe(
			'not_found'
		);
	});
});

describe('refinements and marks', () => {
	it('keep every step and the marks, and show a marked candidate who left as such, without data', async () => {
		const { subject, company } = await employer();
		const withKafka = await person({
			category: backendJunior,
			fsp: true,
			skills: [{ key: 'kafka', trust: 'fsp_verified' }]
		});
		const plain = await person({ category: backendJunior });
		const hiding = await person({ category: backendJunior });
		const need = await backendNeed(subject, { grade: { min: 'junior', max: 'junior' } });
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const pseudonym = (candidateId: string) => deps().pseudonym(candidateId, company.id);

		await markCandidate(deps(), subject, meta, id, pseudonym(plain.id), 'сильный SQL');
		await markCandidate(deps(), subject, meta, id, pseudonym(hiding.id), null);
		const revised = await reviseShortlist(deps(), subject, meta, id, { fsp_only: true });
		expect(revised).toMatchObject({ revision: 2, change: { fsp_only: { from: false, to: true } } });
		expect((await apiError(reviseShortlist(deps(), subject, meta, id, { fsp_only: true }))).details?.[0]?.code).toBe(
			'no_change'
		);

		await database.db.execute(sql`update candidates set visibility = 'hidden' where id = ${hiding.id}`);
		const view = await openShortlist(deps(), subject, id);
		expect(view.revision.seq).toBe(2);
		expect(view.history.map((step) => step.seq)).toEqual([1, 2]);
		expect(view.items.map((item) => item.candidateId)).toEqual([withKafka.id]);
		const states = Object.fromEntries(view.marked.map((mark) => [mark.candidateId ?? 'gone', mark]));
		expect(states[plain.id]).toMatchObject({
			state: 'not_matching',
			note: 'сильный SQL',
			pseudonym: pseudonym(plain.id)
		});
		expect(states.gone).toMatchObject({ state: 'unavailable', pseudonym: null, note: null });

		// The first step is still there and ranked anew.
		const first = await openShortlist(deps(), subject, id, { revision: 1 });
		expect(first.items.map((item) => item.candidateId).sort()).toEqual([withKafka.id, plain.id].sort());

		await unmarkCandidate(deps(), subject, meta, id, pseudonym(plain.id));
		expect((await openShortlist(deps(), subject, id)).marked.map((mark) => mark.candidateId)).toEqual([null]);

		// No step names a candidate.
		const steps = await database.db.select().from(shortlistRevisions).where(eq(shortlistRevisions.shortlistId, id));
		const stored = JSON.stringify(steps.map((step) => [step.query, step.change]));
		for (const candidateId of [withKafka.id, plain.id, hiding.id]) {
			expect(stored).not.toContain(candidateId);
			expect(stored).not.toContain(pseudonym(candidateId));
		}
		const marks = await database.db.select().from(shortlistMarks).where(eq(shortlistMarks.shortlistId, id));
		expect(marks).toHaveLength(2);
	});
});

describe('what if', () => {
	it('names who enters and leaves with a changed format or grade, by what the card shows', async () => {
		const { subject, company } = await employer();
		const remote = await person({ category: frontendMiddle, preferences: { work_formats: ['remote'] } });
		const office = await person({ category: frontendMiddle, preferences: { work_formats: ['office'] } });
		const senior = await person({ category: { specialization: 'frontend', grade: 'senior' } });
		const need = await createNeed(needDeps(), subject, meta, {
			form: { specialization: 'frontend', grade: { min: 'middle', max: 'middle' }, skill_keys: [], nice_skill_keys: [] }
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});

		const byFormat = await whatIf(deps(), subject, id, { work_format: 'remote' });
		expect(byFormat.entered).toEqual([]);
		expect(byFormat.left.map((entry) => [entry.candidateId, entry.reason.code])).toEqual([
			[office.id, 'format_not_accepted']
		]);
		expect(byFormat.after).toBe(byFormat.before - 1);
		expect(byFormat.left[0]?.pseudonym).toBe(deps().pseudonym(office.id, company.id));

		const byGrade = await whatIf(deps(), subject, id, { grade: 'senior' });
		expect(byGrade.entered.map((entry) => [entry.candidateId, entry.reason])).toEqual([
			[senior.id, { code: 'category', specialization: 'frontend', grade: 'senior' }]
		]);
		expect(byGrade.left.map((entry) => entry.candidateId).sort()).toEqual([remote.id, office.id].sort());

		const many = await apiError(whatIf(deps(), subject, id, { grade: 'senior', fsp_only: true }));
		expect([many.code, many.details?.[0]?.code]).toEqual(['validation_failed', 'one_condition']);
	});

	it('answers about the range only by intervals of the cohort of the day, so a series of ranges reveals no one', async () => {
		const { subject, company } = await employer();
		const expecting = (amount: number) =>
			person({
				category: { specialization: 'qa', grade: 'junior' },
				preferences: {
					salary_expectation: { min: amount, max: null, currency: 'RUB', period: 'month', tax_base: 'net' }
				}
			});
		// Six expect 100–149 thousand, one — the target — 240 thousand.
		for (const amount of [100_000, 110_000, 120_000, 130_000, 140_000, 149_000]) await expecting(amount);
		const target = await expecting(240_000);
		const need = await createNeed(needDeps(), subject, meta, {
			form: { specialization: 'qa', grade: { min: 'junior', max: 'junior' }, skill_keys: [], nice_skill_keys: [] }
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const ask = async (max: number) => {
			const answer = await whatIf(deps(), subject, id, { salary: { min: 50_000, max, tax_base: 'net' } });
			const [cohort] = answer.salary?.after ?? [];
			if (!cohort) throw new Error('no cohort answer');
			return cohort;
		};
		// Within one interval of the scale the answer is one.
		expect(await ask(150_001)).toEqual(await ask(174_999));
		// Seven stated: «7» is shown as five; every answer is a multiple of five or «< 5».
		const series = [];
		for (let max = 50_000; max <= 400_000; max += 5_000) series.push(await ask(max));
		for (const answer of series) {
			expect(answer.of).toEqual({ value: 5 });
			const value = 'value' in answer.not_below ? answer.not_below.value : 0;
			expect(value % 5).toBe(0);
		}
		// The series below and above the target's expectation reads the same: it cannot be located.
		const counts = (answer: Awaited<ReturnType<typeof ask>>) => [answer.not_below, answer.of];
		expect(counts(await ask(230_000))).toEqual(counts(await ask(260_000)));

		// The target leaves the catalog the same day: the answers of the day do not change.
		const before = await ask(260_000);
		await database.db.execute(sql`update candidates set visibility = 'hidden' where id = ${target.id}`);
		expect(await ask(260_000)).toEqual(before);
		const [snapshot] = await database.db
			.select()
			.from(salaryCohortSnapshots)
			.where(and(eq(salaryCohortSnapshots.companyId, company.id), eq(salaryCohortSnapshots.specialization, 'qa')));
		expect(snapshot?.cohort).toMatchObject({ size: 7, stated: { gross: 0, net: 7 } });
		// A shortlist page shows the range of the need the same way, never by name.
		const view = await openShortlist(deps(), subject, id);
		expect(JSON.stringify(view.items)).not.toContain('salary');
	});
});

describe('«Оцените подбор»', () => {
	it('mixes the shortlist and a keyword search blindly and keeps the judgement without naming candidates', async () => {
		const { subject } = await employer();
		const tested = await person({ category: { specialization: 'data_ml', grade: 'senior' }, margin: 8 });
		const claimer = await person({ skills: [{ key: 'airflow', trust: 'claimed' }] });
		const need = await createNeed(needDeps(), subject, meta, {
			form: {
				specialization: 'data_ml',
				grade: { min: 'senior', max: 'senior' },
				skill_keys: ['airflow'],
				nice_skill_keys: []
			}
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		// The experiment over the whole catalog: the keyword search reaches a candidate without a category.
		const started = await startEvaluation(deps(), subject, meta, id, 'whole_catalog');
		const shown = started.cards.map((card) => card.candidateId);
		expect(shown).toContain(tested.id);
		expect(shown).toContain(claimer.id);
		expect(Object.keys(started.cards[0] ?? {}).sort()).toEqual(['candidateId', 'position', 'pseudonym']);

		const chosen = started.cards.find((card) => card.candidateId === tested.id);
		if (!chosen) throw new Error('the tested candidate is not shown');
		const result = await judgeEvaluation(deps(), subject, meta, id, started.id, [chosen.position]);
		// The tested candidate is the shortlist's; the keyword search finds only who writes the word.
		expect(result).toMatchObject({ selected: 1, precision_at_10: { product: 0.1 } });
		expect(result.precision_at_10.keywords).toBeLessThanOrEqual(0.1);
		const [stored] = await database.db
			.select()
			.from(shortlistEvaluations)
			.where(eq(shortlistEvaluations.id, started.id));
		expect(JSON.stringify(stored?.cards)).not.toMatch(/"pseudonym":"/u);
		expect(stored?.scope).toBe('whole_catalog');
		expect(
			(await apiError(judgeEvaluation(deps(), subject, meta, id, started.id, [chosen.position]))).details?.[0]?.code
		).toBe('already_judged');

		// On the confirmed pool the keyword search takes the shortlist's categories: no one without a category.
		const pooled = await person({
			category: { specialization: 'data_ml', grade: 'senior' },
			skills: [{ key: 'airflow', trust: 'claimed' }]
		});
		const onPool = await startEvaluation(deps(), subject, meta, id, 'confirmed_pool');
		const pool = onPool.cards.map((card) => card.candidateId);
		expect(pool).toContain(pooled.id);
		expect(pool).not.toContain(claimer.id);
		await judgeEvaluation(deps(), subject, meta, id, onPool.id, []);
		const summary = await evaluationSummary(deps(), subject, id);
		expect(summary.mean.whole_catalog).toMatchObject({ count: 1, precision_at_10: { product: 0.1 } });
		expect(summary.mean.confirmed_pool).toMatchObject({ count: 1, precision_at_10: { product: 0, keywords: 0 } });
	});
});

describe('the ranking cache', () => {
	it('keys a shortlist ranking by its step: a refinement is ranked anew', async () => {
		const { subject } = await employer();
		await person({ category: { specialization: 'qa', grade: 'senior' }, skills: [{ key: 'kafka', trust: 'claimed' }] });
		const need = await createNeed(needDeps(), subject, meta, {
			form: {
				specialization: 'qa',
				grade: { min: 'senior', max: 'senior' },
				skill_keys: ['kafka'],
				nice_skill_keys: []
			}
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const first = await openShortlist(deps(), subject, id);
		await reviseShortlist(deps(), subject, meta, id, { skill_keys: ['kafka', 'docker'] });
		const second = await openShortlist(deps(), subject, id);
		expect(first.items[0]?.needMatch.score).not.toBe(second.items[0]?.needMatch.score);
		expect(second.items[0]?.needMatch.components.required.value).toBeLessThan(
			first.items[0]?.needMatch.components.required.value ?? 0
		);
	});
});

describe('clock', () => {
	it('takes a new cohort on the next day', async () => {
		const { subject, company } = await employer();
		await person({ category: { specialization: 'frontend', grade: 'senior' } });
		const need = await createNeed(needDeps(), subject, meta, {
			form: { specialization: 'frontend', grade: { min: 'senior', max: 'senior' }, skill_keys: [], nice_skill_keys: [] }
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const range = { salary: { min: 100_000, max: 200_000, tax_base: 'gross' as const } };
		await whatIf(deps(), subject, id, range);
		clock = () => new Date(Date.now() + DAY);
		try {
			await whatIf(deps(), subject, id, range);
		} finally {
			clock = () => new Date();
		}
		const days = await database.db
			.select({ date: salaryCohortSnapshots.snapshotDate })
			.from(salaryCohortSnapshots)
			.where(eq(salaryCohortSnapshots.companyId, company.id));
		expect(days).toHaveLength(2);
	});
});

describe('an offer from a shortlist', () => {
	it('takes the reasons as points of «why you» with their sources and names the need', async () => {
		const { subject } = await employer();
		const person_ = await person({
			category: { specialization: 'qa', grade: 'middle' },
			preferences: { work_formats: ['remote'] }
		});
		const need = await createNeed(needDeps(), subject, meta, {
			form: {
				specialization: 'qa',
				grade: { min: 'middle', max: 'middle' },
				skill_keys: ['manual_testing'],
				nice_skill_keys: [],
				work_format: 'remote'
			}
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const found = await shortlistMatchOf(deps(), subject, id, person_.id);
		if (!found) throw new Error('the candidate is not in the shortlist');
		// The offer starts with the format the shortlist worded «why you» by, not with the first of the list.
		expect(offerTermsOfNeed(found.form)).toEqual({ workFormat: 'remote', salary: null });
		const points = whyYouFromShortlist(found.match, [], {
			skills: {},
			workFormats: { remote: 'Удалённо' },
			specializations: {},
			grades: {}
		});
		expect(points.map((point) => point.source.kind)).toContain('test_block');
		expect(points.map((point) => point.source.kind)).toContain('preference');
		const invitationDeps = {
			db: database.db,
			crypto: createFieldCrypto({
				keys: new Map([[1, Buffer.alloc(32, 7)]]),
				activeVersion: 1,
				hmacSecret: Buffer.alloc(32, 9)
			}),
			now: () => new Date()
		};
		const sent = await createInvitation(invitationDeps, subject, meta, {
			...offerTerms({ whyYou: points.slice(0, 5).map(({ text, source }) => ({ text, source })) }),
			candidateId: person_.id,
			needId: found.needId
		});
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row?.needId).toBe(need.id);

		// A block the candidate's test did not confirm is not a source.
		const other = await employer();
		const refused = await apiError(
			createInvitation(invitationDeps, other.subject, meta, {
				...offerTerms({ whyYou: [{ text: 'Блок', source: { kind: 'test_block', ref: 'be.algo' } }] }),
				candidateId: person_.id
			})
		);
		expect([refused.code, refused.details?.[0]?.path]).toEqual(['validation_failed', 'why_you.0.source.ref']);
	});
});

describe('the group «грейд не подтверждён»', () => {
	const frontendJunior = { specialization: 'frontend', grade: 'junior' } as const;

	/** An official FSP result of the candidate's own, as the synchronization stores it. */
	async function fspResult(candidateId: string, award: 'winner' | 'prize' | 'participant') {
		const competitionId = randomBytes(6).toString('hex');
		const resultId = randomBytes(6).toString('hex');
		await database.db.insert(sourceFacts).values({
			candidateId,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${resultId}`,
			eventKey: `fsp:competition:${competitionId}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {
				result: { id: resultId, competitionId, place: 1, award, status: 'official' },
				competition: {
					id: competitionId,
					title: 'Кубок',
					discipline: 'product',
					level: 'russian_cup',
					startDate: '2026-03-01'
				}
			},
			payloadSha256: randomBytes(32).toString('hex'),
			occurredOn: '2026-03-01',
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		});
	}

	it('follows every confirmed candidate by the declaration, out of the counts, ordered as the confirmed are', async () => {
		const { subject } = await employer();
		const { db } = database;
		const confirmed = await person({ category: frontendJunior, margin: -8 });
		// Never tested, a long FSP record; tested and not confirmed, nothing else: both declared Frontend Junior.
		const neverTested = await person({ skills: [{ key: 'javascript', trust: 'claimed' }] });
		await declareGrade(db, neverTested.id, 'frontend', 'junior');
		await fspResult(neverTested.id, 'winner');
		await fspResult(neverTested.id, 'participant');
		const failed = await person({ skills: [{ key: 'javascript', trust: 'claimed' }] });
		await declareGrade(db, failed.id, 'frontend', 'junior');
		await decide(db, failed.id, { ...frontendJunior, outcome: 'not_confirmed' });
		// Not of the group: declared another grade at last, or holding a category of the specialization.
		const redeclared = await person();
		await declareGrade(db, redeclared.id, 'frontend', 'junior');
		await declareGrade(db, redeclared.id, 'frontend', 'senior');
		const otherGrade = await person({ category: { specialization: 'frontend', grade: 'senior' } });
		await declareGrade(db, otherGrade.id, 'frontend', 'junior');

		const need = await createNeed(needDeps(), subject, meta, {
			form: {
				specialization: 'frontend',
				grade: { min: 'junior', max: 'junior' },
				skill_keys: ['javascript'],
				nice_skill_keys: []
			}
		});
		const { id } = await createShortlist(deps(), subject, meta, need.id, {});
		const view = await openShortlist(deps(), subject, id);
		const ids = view.items.map((item) => item.candidateId);
		expect(ids).toEqual([confirmed.id, neverTested.id, failed.id]);
		expect(view.groups).toEqual({ covers: 1, gaps: 0, unconfirmed: 2 });
		const match = (candidateId: string) => view.items.find((item) => item.candidateId === candidateId)?.needMatch;
		expect(match(confirmed.id)).toMatchObject({ group: 'confirmed', declared: null });
		expect(match(neverTested.id)).toMatchObject({
			group: 'unconfirmed',
			declared: frontendJunior,
			category: null,
			fsp: { competitions: 2, podiums: 1, team_podiums: 0, relevant: 2 }
		});
		// The claim of JavaScript is capped as the declared Frontend Junior test would check it; the FSP record puts the
		// never tested candidate above the one with the same claim and no FSP.
		expect(match(neverTested.id)?.skills).toEqual([
			expect.objectContaining({ skill_key: 'javascript', basis: 'claimed', value: 0.3 })
		]);
		expect(match(neverTested.id)?.reasons.map((reason) => reason.code)).toContain('fsp_record');
		expect(match(failed.id)?.fsp).toEqual({ competitions: 0, podiums: 0, team_podiums: 0, relevant: 0 });
		// A filter by what the test confirmed leaves the group out: no test confirmed anything of theirs.
		const filtered = await whatIf(deps(), subject, id, {
			confirmed_skill: { skill_key: 'javascript', required: true }
		});
		expect(filtered.left.map((entry) => entry.candidateId)).toEqual(
			expect.arrayContaining([neverTested.id, failed.id])
		);
		// «What if» by the grade names a declaration as one, never as a category.
		const senior = await whatIf(deps(), subject, id, { grade: 'senior' });
		expect(senior.entered.map((entry) => [entry.candidateId, entry.reason])).toEqual(
			expect.arrayContaining([
				[redeclared.id, { code: 'grade_declared', specialization: 'frontend', grade: 'senior' }],
				[otherGrade.id, { code: 'category', specialization: 'frontend', grade: 'senior' }]
			])
		);

		// An offer to such a candidate records no confirmed category.
		const found = await shortlistMatchOf(deps(), subject, id, neverTested.id);
		expect(found?.match.group).toBe('unconfirmed');
		const sent = await createInvitation(
			{
				db,
				crypto: createFieldCrypto({
					keys: new Map([[1, Buffer.alloc(32, 7)]]),
					activeVersion: 1,
					hmacSecret: Buffer.alloc(32, 9)
				}),
				now: () => new Date()
			},
			subject,
			meta,
			{ ...offerTerms(), candidateId: neverTested.id, needId: need.id }
		);
		const [terms] = await db.select().from(invitationTerms).where(eq(invitationTerms.invitationId, sent.invitationId));
		expect(terms?.category).toBeNull();
	});
});
