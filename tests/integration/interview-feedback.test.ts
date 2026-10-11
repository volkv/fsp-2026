// The employer's feedback after the interview (docs/domain.md, section 13.7): only the company of an accepted offer
// leaves it, once, and corrects it within a short window; the candidate sees it in full, other companies do not; the
// operator reads it by category and bank release with small numbers suppressed; the order of candidates never moves.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidateCategories,
	consentEvents,
	interviewFeedback,
	matchRulesets,
	productPolicies
} from '$lib/server/db/schema';
import {
	candidateInterviewFeedback,
	companyInterviewFeedback,
	interviewCalibration,
	leaveInterviewFeedback,
	reviseInterviewFeedback,
	type InterviewFeedbackInput
} from '$lib/server/hiring/interview-feedback';
import { uuidv7 } from '$lib/server/ids';
import type { InvitationDeps, RequestMeta } from '$lib/server/invitations/deps';
import { Refusal } from '$lib/server/invitations/errors';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation } from '$lib/server/invitations/send';
import { fail } from '$lib/server/ml/result';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import { rankForNeed } from '$lib/server/matching/rank';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser,
	offerTerms
} from '../helpers/factories';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const EPOCH = new Date(Date.now() - 400 * DAY);
const THRESHOLD = 5;

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

let database: TestDatabase;
let taxonomyVersionId: string;
let documents: Record<'pd' | 'catalog' | 'disclosure', { id: string }>;
let clock = new Date();
let deps: InvitationDeps;
const meta: RequestMeta = { requestId: 'test-request' };

const operator: AccessSubject = {
	userId: uuidv7(),
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: true, admin: false, extraPermissions: [] }
};

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	deps = { db, crypto, now: () => clock };
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	await db.insert(matchRulesets).values({
		version: shippedMatchRuleset.version,
		taxonomyVersionId,
		params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
	});
	documents = {
		pd: await createPublishedDocument(db, 'pd_processing', { publishedAt: EPOCH }),
		catalog: await createPublishedDocument(db, 'catalog_visibility', { publishedAt: EPOCH }),
		disclosure: await createPublishedDocument(db, 'contact_disclosure', { publishedAt: EPOCH })
	};
	await db.insert(productPolicies).values([
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
			effectiveFrom: EPOCH
		},
		{
			kind: 'hiring_policy',
			version: 1,
			params: {
				outcome_due_days: 30,
				reminder_intervals_days: [7],
				max_reminders: 2,
				stages: ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'],
				outcome_reason_codes: ['salary', 'other']
			},
			effectiveFrom: EPOCH
		},
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: THRESHOLD }, effectiveFrom: EPOCH }
	]);
});

afterAll(async () => {
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

async function employer() {
	const { db } = database;
	const company = await createCompany(db);
	const member = await createMember(db, company.id, { userId: (await createUser(db)).id });
	if (!member.userId) throw new Error('member without user');
	const vacancy = await createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId });
	const subject: AccessSubject = {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: company.id,
			role: 'owner',
			status: 'active',
			companyStatus: 'verified'
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { company, member, vacancy, subject };
}

/** A candidate in the catalog; with `category` — confirmed by a test before any offer. */
async function candidate(category?: { specialization: SpecializationKey; grade: GradeKey }) {
	const { db } = database;
	const row = await createCandidate(db, { userId: (await createUser(db)).id, visibility: 'catalog' });
	for (const kind of ['pd_processing', 'catalog_visibility'] as const) {
		await db.insert(consentEvents).values({
			subjectCandidateId: row.id,
			kind,
			documentId: kind === 'pd_processing' ? documents.pd.id : documents.catalog.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: row.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(EPOCH.getTime() + DAY)
		});
	}
	if (category) await decide(db, row.id, { ...category, decidedAt: new Date(clock.getTime() - DAY) });
	const subject: AccessSubject = {
		userId: row.userId,
		via: 'session',
		candidate: { id: row.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { ...row, subject };
}

type Company = Awaited<ReturnType<typeof employer>>;
type Person = Awaited<ReturnType<typeof candidate>>;

async function sent(company: Company, person: Person) {
	return createInvitation(deps, company.subject, meta, {
		...offerTerms({ vacancyId: company.vacancy.id, salaryMin: 260_000, salaryMax: 300_000 }),
		candidateId: person.id
	});
}

/** An offer accepted at the current clock: the process it opened. */
async function acceptedProcess(company: Company, person: Person): Promise<string> {
	const offer = await sent(company, person);
	const answer = await respondToInvitation(deps, person.subject, meta, offer.invitationId, {
		termsId: offer.termsId,
		decision: 'accept',
		discloseFields: ['full_name', 'email'],
		disclosureDocumentId: documents.disclosure.id
	});
	if (!answer.processId) throw new Error('no process');
	return answer.processId;
}

async function refusal(operation: Promise<unknown>): Promise<Refusal> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof Refusal) return error;
		throw error;
	}
	throw new Error('the operation was expected to be refused');
}

const feedback = (overrides: Partial<InterviewFeedbackInput> = {}): InterviewFeedbackInput => ({
	level: 'matches',
	blockLevels: {},
	outcome: 'advanced',
	comment: null,
	...overrides
});

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('interview feedback', () => {
	it('is left by the company of the accepted offer only, once, and corrected only within the window', async () => {
		clock = new Date();
		const company = await employer();
		const stranger = await employer();
		const person = await candidate({ specialization: 'backend', grade: 'middle' });
		const [category] = await database.db
			.select()
			.from(candidateCategories)
			.where(and(eq(candidateCategories.candidateId, person.id), eq(candidateCategories.status, 'active')));
		if (!category) throw new Error('no category');

		// Before an acceptance there is no process to leave feedback on.
		const open = await sent(company, person);
		const notYet = await refusal(leaveInterviewFeedback(deps, company.subject, meta, open.invitationId, feedback()));
		expect([notYet.code, notYet.reason]).toEqual(['not_found', 'no_process']);
		const answer = await respondToInvitation(deps, person.subject, meta, open.invitationId, {
			termsId: open.termsId,
			decision: 'accept',
			discloseFields: ['full_name', 'email'],
			disclosureDocumentId: documents.disclosure.id
		});
		const processId = answer.processId;
		if (!processId) throw new Error('no process');

		// Another company and the candidate are not the company side of the process.
		for (const outsider of [stranger.subject, person.subject]) {
			const refused = await refusal(leaveInterviewFeedback(deps, outsider, meta, processId, feedback()));
			expect([refused.code, refused.reason]).toEqual(['not_found', 'not_party']);
		}
		expect((await refusal(companyInterviewFeedback(deps, stranger.subject, processId))).code).toBe('not_found');

		// The form offers the blocks of the category the accepted terms recorded.
		const form = await companyInterviewFeedback(deps, company.subject, processId);
		expect(form.category).toMatchObject({ specialization: 'backend', grade: 'middle' });
		expect(form.category?.blocks.map((block) => block.code)).toEqual(category.confirmedBlocks);
		expect(form.feedback).toBeNull();
		const [judged] = category.confirmedBlocks;
		if (judged === undefined) throw new Error('the category confirmed no block');
		const foreign = 'qa.design';
		const badBlock = await refusal(
			leaveInterviewFeedback(deps, company.subject, meta, processId, feedback({ blockLevels: { [foreign]: 'below' } }))
		);
		expect(badBlock.code).toBe('validation_failed');
		const long = await refusal(
			leaveInterviewFeedback(deps, company.subject, meta, processId, feedback({ comment: 'а'.repeat(501) }))
		);
		expect(long.code).toBe('validation_failed');

		const left = await leaveInterviewFeedback(
			deps,
			company.subject,
			meta,
			processId,
			feedback({ level: 'below', blockLevels: { [judged]: 'below' }, outcome: 'rejected', comment: '  Слабо по SQL  ' })
		);
		expect(left).toMatchObject({
			specialization: 'backend',
			grade: 'middle',
			bankReleaseId: category.bankReleaseId,
			level: 'below',
			blockLevels: { [judged]: 'below' },
			outcome: 'rejected',
			comment: 'Слабо по SQL'
		});
		expect(left.editableUntil).not.toBeNull();
		const [stored] = await database.db
			.select()
			.from(interviewFeedback)
			.where(eq(interviewFeedback.processId, processId));
		expect(stored).toMatchObject({ categoryId: category.id, termsId: open.termsId, candidateId: person.id });

		// A second feedback is refused; a correction within the window is allowed.
		const again = await refusal(leaveInterviewFeedback(deps, company.subject, meta, processId, feedback()));
		expect([again.code, again.reason]).toEqual(['conflict', 'feedback_already_left']);
		clock = new Date(clock.getTime() + 2 * HOUR);
		const revised = await reviseInterviewFeedback(
			deps,
			company.subject,
			meta,
			processId,
			feedback({ level: 'matches', outcome: 'offer' })
		);
		expect(revised).toMatchObject({ level: 'matches', outcome: 'offer', blockLevels: {}, comment: null });
		const strangerRevision = await refusal(
			reviseInterviewFeedback(deps, stranger.subject, meta, processId, feedback())
		);
		expect(strangerRevision.code).toBe('not_found');
		clock = new Date(clock.getTime() + 23 * HOUR);
		const late = await refusal(reviseInterviewFeedback(deps, company.subject, meta, processId, feedback()));
		expect([late.code, late.reason]).toEqual(['conflict', 'edit_window_closed']);
		expect((await companyInterviewFeedback(deps, company.subject, processId)).feedback?.editableUntil).toBeNull();

		// The journal has codes of both acts, never the comment.
		const journal = await database.db
			.select({ action: auditEvents.action, details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.objectId, processId));
		expect(journal.map((event) => event.action).sort()).toEqual([
			'hiring.interview_feedback_left',
			'hiring.interview_feedback_revised'
		]);
		expect(JSON.stringify(journal)).not.toContain('SQL');
	});

	it('shows the candidate the whole feedback about them, and no one else', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate({ specialization: 'backend', grade: 'junior' });
		const other = await candidate({ specialization: 'backend', grade: 'junior' });
		const processId = await acceptedProcess(company, person);
		expect(await candidateInterviewFeedback(deps, person.subject, processId)).toBeNull();
		await leaveInterviewFeedback(
			deps,
			company.subject,
			meta,
			processId,
			feedback({ level: 'above', outcome: 'offer', comment: 'Сильнее грейда в конкурентности' })
		);
		const seen = await candidateInterviewFeedback(deps, person.subject, processId);
		expect(seen).toMatchObject({
			level: 'above',
			outcome: 'offer',
			comment: 'Сильнее грейда в конкурентности',
			grade: 'junior',
			editableUntil: null
		});
		expect((await refusal(candidateInterviewFeedback(deps, other.subject, processId))).code).toBe('not_found');
	});

	it('cannot be left on an offer sent without a confirmed grade', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const processId = await acceptedProcess(company, person);
		expect((await companyInterviewFeedback(deps, company.subject, processId)).category).toBeNull();
		const refused = await refusal(leaveInterviewFeedback(deps, company.subject, meta, processId, feedback()));
		expect([refused.code, refused.reason]).toEqual(['conflict', 'no_confirmed_grade']);
	});

	it('never moves a candidate in a selection', async () => {
		clock = new Date();
		const company = await employer();
		const people = [
			await candidate({ specialization: 'devops', grade: 'senior' }),
			await candidate({ specialization: 'devops', grade: 'middle' }),
			await candidate({ specialization: 'devops', grade: 'junior' })
		];
		const ids = people.map((person) => person.id);
		const [ruleset] = await database.db.select().from(matchRulesets);
		if (!ruleset) throw new Error('no ruleset');
		const options = {
			ruleset: { id: ruleset.id, version: ruleset.version, params: matchRulesetParamsSchema.parse(ruleset.params) },
			testResults: GRADE_DECISION_RESULTS,
			now: clock,
			semanticText: null
		};
		const modelsOff = {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' }))
		};
		const before = await rankForNeed(database.db, modelsOff, null, ids, options);
		const top = before.ranked[0]?.snapshot.id;
		const topPerson = people.find((person) => person.id === top);
		if (!topPerson) throw new Error('no ranked candidate');
		// The strongest one is judged weaker than the grade, block by block: the selection does not change.
		const processId = await acceptedProcess(company, topPerson);
		const form = await companyInterviewFeedback(deps, company.subject, processId);
		await leaveInterviewFeedback(
			deps,
			company.subject,
			meta,
			processId,
			feedback({
				level: 'below',
				outcome: 'rejected',
				blockLevels: Object.fromEntries((form.category?.blocks ?? []).map((block) => [block.code, 'below']))
			})
		);
		const after = await rankForNeed(database.db, modelsOff, null, ids, options);
		expect(after).toEqual(before);
	});
});

describe('the operator’s calibration', () => {
	it('counts agreement by category and bank release, small numbers suppressed', async () => {
		clock = new Date();
		const levels = ['matches', 'matches', 'matches', 'matches', 'matches', 'below'] as const;
		for (const level of levels) {
			const company = await employer();
			const person = await candidate({ specialization: 'qa', grade: 'middle' });
			const processId = await acceptedProcess(company, person);
			await leaveInterviewFeedback(deps, company.subject, meta, processId, feedback({ level }));
		}
		for (const level of ['above', 'above'] as const) {
			const company = await employer();
			const person = await candidate({ specialization: 'qa', grade: 'senior' });
			const processId = await acceptedProcess(company, person);
			await leaveInterviewFeedback(deps, company.subject, meta, processId, feedback({ level }));
		}

		const calibration = await interviewCalibration(database.db, operator, THRESHOLD);
		const qa = calibration.rows.filter((row) => row.specialization === 'qa');
		expect(qa).toEqual([
			{
				specialization: 'qa',
				grade: 'middle',
				bankReleaseId: 'test-release',
				total: { value: 6 },
				below: { below: THRESHOLD },
				matches: { value: 5 },
				above: { value: 0 },
				agreement: 5 / 6,
				blocks: []
			},
			{
				specialization: 'qa',
				grade: 'senior',
				bankReleaseId: 'test-release',
				total: { below: THRESHOLD },
				below: { value: 0 },
				matches: { value: 0 },
				above: { below: THRESHOLD },
				agreement: null,
				blocks: []
			}
		]);

		// A company or a candidate does not read it.
		const company = await employer();
		const refused = await refusal(interviewCalibration(database.db, company.subject, THRESHOLD));
		expect(refused.code).toBe('forbidden');
	});
});
