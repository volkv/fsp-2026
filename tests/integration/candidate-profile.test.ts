// The candidate's own profile (docs/domain.md, sections 7.1, 12.9): the fields typed by hand, encrypted; the reading of
// a resume suggesting the name, the contacts and the soft skills with their quotes, accepted or rejected by the
// candidate; the block list of companies as the catalog applies it; the PDF profile with the QR code of a signed
// confirmation of the category whose status follows the category; and refusals on someone else's rows.
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { runOperation } from '$lib/server/api/operation';
import type { ApiServices } from '$lib/server/api/services';
import { checkAttestationHolderOperation, verifyCategoryAttestationOperation } from '$lib/server/api/v1/verify';
import { verifyAttestation } from '$lib/server/attestations/verify';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidateCompanyBlocks,
	candidates,
	categorizationRulesets,
	categoryAttestations,
	claims,
	consentEvents,
	demoSessions,
	documentExtractions,
	evidenceRuns,
	files,
	productPolicies,
	profileSuggestions,
	resumeDocuments,
	skillInferences,
	sourceFacts
} from '$lib/server/db/schema';
import { findInCatalog } from '$lib/server/employer/card';
import { ApiError } from '$lib/server/errors/api-error';
import { checkReceiptSignature, createReceiptSigner, receiptKeySet } from '$lib/server/fsp/receipts';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { JobFailure, type JobResult } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { searchCandidates } from '$lib/server/matching/search';
import { fail, ok } from '$lib/server/ml/result';
import { checkResumeAnswer } from '$lib/server/ml/resume-extract';
import { blockCompany, findCompaniesToBlock, unblockCompany } from '$lib/server/profile/company-blocks';
import { addManualExperience, removeManualExperience, updateManualExperience } from '$lib/server/profile/experience';
import { decideSuggestion, readOwnProfile, updateOwnProfile } from '$lib/server/profile/fields';
import { qrModules, renderProfilePdf } from '$lib/server/profile/pdf';
import { attestationUrl, buildProfilePdf } from '$lib/server/profile/pdf-input';
import { ownProfileView } from '$lib/server/profile/view';
import { deleteResume } from '$lib/server/resumes/delete';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { loadResumeTaxonomy, resumeLexicon } from '$lib/server/resumes/taxonomy';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import { decide, invalidate } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createPublishedDocument,
	createUser,
	randomSha256
} from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const ORIGIN = 'http://career.test';
const DAY = 86_400_000;

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const signer = createReceiptSigner({ issuer: ORIGIN, keyId: 'test-1', seed: Buffer.alloc(32, 3) });
const meta: RequestMeta = { requestId: 'profile-test', ip: '127.0.0.1', userAgent: 'vitest' };
const now = () => new Date();

let database: TestDatabase;
let catalogDocument: string;

const deps = () => ({ db: database.db, crypto, now });

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const { db } = database;
	catalogDocument = (await createPublishedDocument(db, 'catalog_visibility')).id;
	await db.insert(productPolicies).values({
		kind: 'minor_policy',
		version: 1,
		params: { enabled: false, authority_methods: ['in_person'] },
		effectiveFrom: new Date(Date.now() - DAY)
	});
}, 300_000);

afterAll(async () => {
	await database.drop();
});

// --- Fixtures ---------------------------------------------------------------------------------------------------------

/** A candidate whose account has a readable address, with `pd_processing` in effect unless said otherwise. */
async function person(options: { processingConsent?: boolean; catalog?: boolean } = {}) {
	const { db } = database;
	const user = await createUser(db, { emailEnc: crypto.encrypt('maria@example.org', 'users.email') });
	const row = await createCandidate(
		db,
		{ userId: user.id, visibility: options.catalog ? 'catalog' : 'hidden' },
		{ processingConsent: options.processingConsent ?? true }
	);
	if (options.catalog) {
		await db.insert(consentEvents).values({
			subjectCandidateId: row.id,
			kind: 'catalog_visibility',
			documentId: catalogDocument,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: user.id,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(Date.now() - DAY)
		});
	}
	const subject: AccessSubject = {
		userId: user.id,
		via: 'session',
		candidate: { id: row.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { ...row, subject };
}

const fields = {
	last_name: 'Иванова',
	first_name: 'Мария',
	middle_name: 'Сергеевна',
	phone: '8 (912) 345-67-89',
	telegram: 't.me/maria_dev',
	headline: 'Backend-разработчик',
	soft_skill_keys: ['teamwork', 'mentoring']
};

async function refusal(action: Promise<unknown>): Promise<ApiError> {
	const caught: unknown = await action.then(
		() => null,
		(error: unknown) => error
	);
	if (!(caught instanceof ApiError)) throw new Error(`expected a refusal, got ${String(caught)}`);
	return caught;
}

// A parsed resume as `docparse` leaves it: the blocks of the text with code point offsets.
const RESUME_BLOCKS = [
	'Иванова Мария Сергеевна',
	'Телефон: +7 (912) 345-67-89 · maria.ivanova@mail.ru · Telegram: @maria_dev',
	'Опыт работы',
	'2021 — 2024',
	'Python-разработчик',
	'ООО «Пример»',
	'О себе',
	'Коммуникабельна, люблю работать в команде.'
];

async function parsedResume(candidate: { id: string; userId: string }) {
	const { db } = database;
	const [file] = await db
		.insert(files)
		.values({
			ownerUserId: candidate.userId,
			purpose: 'resume',
			storageKey: `resume/${randomBytes(8).toString('hex')}`,
			sha256: randomSha256(),
			sizeBytes: 100,
			declaredName: 'resume.pdf',
			detectedMime: 'application/pdf',
			status: 'ready'
		})
		.returning();
	if (!file) throw new Error('file not inserted');
	const [document] = await db
		.insert(resumeDocuments)
		.values({ candidateId: candidate.id, fileId: file.id, seq: 1, isCurrent: true, parseStatus: 'parsed' })
		.returning();
	if (!document) throw new Error('resume not inserted');
	let offset = 0;
	const blocks = RESUME_BLOCKS.map((text, index) => {
		const block = {
			id: `p1-b${String(index + 1).padStart(3, '0')}`,
			page: 1,
			kind: index === 2 || index === 6 ? 'heading' : 'paragraph',
			column: null,
			start: offset,
			end: offset + Array.from(text).length
		};
		offset = block.end + 1;
		return block;
	});
	const [extraction] = await db
		.insert(documentExtractions)
		.values({
			resumeDocumentId: document.id,
			extractorName: 'docparse',
			extractorVersion: '1.0.0+test',
			inputSha256: randomSha256(),
			status: 'complete',
			text: RESUME_BLOCKS.join('\n'),
			blocks,
			flags: { ocrUsed: false, incompleteReasons: [] }
		})
		.returning();
	if (!extraction) throw new Error('extraction not inserted');
	return { resumeDocumentId: document.id, extractionId: extraction.id, blocks };
}

const log = createLogger({ service: 'test' });

/** Runs `resume.extract` of the extraction as the worker does. */
async function extract(extractionId: string, adapter: Parameters<typeof createResumeExtractHandler>[0]['adapter']) {
	const { db } = database;
	await db.transaction((tx) =>
		enqueueJob(
			tx,
			'resume.extract',
			{ extraction_id: extractionId },
			{ inputVersion: '1', createdBy: { kind: 'system' } }
		)
	);
	const claimed = await claimJob(db, 'worker-test', ['resume.extract']);
	if (claimed?.type !== 'resume.extract') throw new Error('no resume.extract job');
	const job = {
		...claimed,
		payload: JOB_TYPES['resume.extract'].payload.parse(claimed.payload)
	} as ClaimedJob<'resume.extract'>;
	const handler = createResumeExtractHandler({ adapter, crypto: () => crypto, now });
	let result: JobResult;
	try {
		result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: log.child({ job_id: job.id })
		});
	} catch (error) {
		if (error instanceof JobFailure) throw new Error(`the extraction failed: ${error.code}`, { cause: error });
		throw error;
	}
	await completeJob(db, job, result);
}

const withoutModel = () => ({
	extract: () => Promise.resolve(fail('disabled', 'extract: off in the test', { reason: 'test' }))
});

// --- Manual fields --------------------------------------------------------------------------------------------------

describe('profile fields by hand', () => {
	it('stores the name and the contacts encrypted, reads them back normalized and journals only field names', async () => {
		const candidate = await person();
		const changed = await updateOwnProfile(deps(), candidate.subject, meta, fields);
		expect(changed).toEqual(['full_name', 'phone', 'telegram', 'headline', 'soft_skills']);

		const [row] = await database.db.select().from(candidates).where(eq(candidates.id, candidate.id));
		if (!row?.lastNameEnc || !row.phoneEnc || !row.telegramEnc) throw new Error('the fields were not stored');
		for (const sealed of [row.lastNameEnc, row.phoneEnc, row.telegramEnc]) {
			const raw = Buffer.from(sealed).toString('utf8');
			expect(raw).not.toContain('Иванова');
			expect(raw).not.toContain('9123456789');
			expect(raw).not.toContain('maria_dev');
		}
		expect(row.softSkillKeys).toEqual(['teamwork', 'mentoring']);

		expect(await readOwnProfile(database.db, crypto, candidate.id)).toEqual({
			fullName: { last: 'Иванова', first: 'Мария', middle: 'Сергеевна' },
			phone: '+79123456789',
			telegram: '@maria_dev',
			email: 'maria@example.org',
			headline: 'Backend-разработчик',
			softSkillKeys: ['teamwork', 'mentoring'],
			desiredRoleKeys: []
		});

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'profile.updated'), eq(auditEvents.subjectCandidateId, candidate.id)));
		expect(event?.details).toEqual({ fields: ['full_name', 'phone', 'telegram', 'headline', 'soft_skills'] });
		expect(JSON.stringify(event)).not.toContain('Иванова');

		// The same form again changes nothing and journals nothing.
		expect(await updateOwnProfile(deps(), candidate.subject, meta, fields)).toEqual([]);
	});

	it('refuses half a name, a phone that is not one, an unknown soft skill, and a profile without the processing consent', async () => {
		const candidate = await person();
		const invalid = await refusal(
			updateOwnProfile(deps(), candidate.subject, meta, {
				...fields,
				first_name: null,
				phone: '12-34',
				soft_skill_keys: ['charisma']
			})
		);
		expect(invalid.code).toBe('validation_failed');
		expect(invalid.details?.map((detail) => detail.path)).toEqual(['first_name', 'phone', 'soft_skill_keys']);

		const withoutConsent = await person({ processingConsent: false });
		expect((await refusal(updateOwnProfile(deps(), withoutConsent.subject, meta, fields))).code).toBe(
			'policy_violation'
		);
	});

	it('keeps experience stated by hand with its length, and refuses another candidate’s entry', async () => {
		const candidate = await person();
		const other = await person();
		const first = await addManualExperience(deps(), candidate.subject, meta, {
			position_title: 'Python-разработчик',
			organization_name: 'ООО «Пример»',
			role_key: 'backend',
			period_from: '2020-01',
			period_to: '2020-12',
			skill_keys: ['python', 'postgresql'],
			description: null
		});
		await addManualExperience(deps(), candidate.subject, meta, {
			position_title: 'Стажёр',
			organization_name: null,
			role_key: null,
			period_from: '2020-06',
			period_to: '2021-03',
			skill_keys: [],
			description: 'Тесты'
		});
		const view = await ownProfileView(deps(), candidate.subject);
		expect(view.experience.map((entry) => [entry.positionTitle, entry.periodFrom, entry.periodTo])).toEqual([
			['Стажёр', '2020-06', '2021-03'],
			['Python-разработчик', '2020-01', '2020-12']
		]);
		expect(view.experienceMonths).toBe(15);

		const unknownSkill = await refusal(
			addManualExperience(deps(), candidate.subject, meta, {
				position_title: 'X',
				organization_name: null,
				role_key: 'no_such_role',
				period_from: '2022-01',
				period_to: '2021-01',
				skill_keys: ['no_such_skill'],
				description: null
			})
		);
		expect(unknownSkill.details?.map((detail) => detail.path)).toEqual(['role_key', 'skill_keys', 'period_to']);

		const input = {
			position_title: 'Чужая',
			organization_name: null,
			role_key: null,
			period_from: '2020-01',
			period_to: null,
			skill_keys: [],
			description: null
		};
		expect((await refusal(updateManualExperience(deps(), other.subject, meta, first, input))).code).toBe('not_found');
		expect((await refusal(removeManualExperience(deps(), other.subject, meta, first))).code).toBe('not_found');
		await removeManualExperience(deps(), candidate.subject, meta, first);
		expect((await ownProfileView(deps(), candidate.subject)).experience).toHaveLength(1);
	});
});

// --- Suggestions of the resume -----------------------------------------------------------------------------------------

describe('profile fields from the resume', () => {
	it('suggests the name, the contacts and the soft skills by rules, each with its quote, sealed in storage', async () => {
		const candidate = await person();
		const resume = await parsedResume(candidate);
		await extract(resume.extractionId, withoutModel);

		const view = await ownProfileView(deps(), candidate.subject);
		expect(view.suggestions.map((s) => [s.field, s.label, s.quote.text])).toEqual([
			['full_name', 'Иванова Мария Сергеевна', 'Иванова Мария Сергеевна'],
			['phone', '+79123456789', '+7 (912) 345-67-89'],
			['email', 'maria.ivanova@mail.ru', 'maria.ivanova@mail.ru'],
			['telegram', '@maria_dev', '@maria_dev'],
			['soft_skill', 'Коммуникабельность', 'Коммуникабельна'],
			['soft_skill', 'Работа в команде', 'работать в команде']
		]);
		// No profile value became evidence: the claims are the resume's skills and experience only.
		const stored = await database.db
			.select({ type: claims.claimType })
			.from(claims)
			.where(eq(claims.candidateId, candidate.id));
		expect(stored.map((claim) => claim.type)).not.toContain('full_name');
		const rows = await database.db
			.select()
			.from(profileSuggestions)
			.where(eq(profileSuggestions.candidateId, candidate.id));
		for (const row of rows) {
			const raw = JSON.stringify(row) + (row.valueEnc ? Buffer.from(row.valueEnc).toString('utf8') : '');
			expect(raw).not.toContain('Иванова');
			expect(raw).not.toContain('maria_dev');
		}
	});

	it('takes the values of the model the same way, and the candidate accepts, rejects or is refused', async () => {
		const candidate = await person();
		const other = await person();
		const resume = await parsedResume(candidate);
		const taxonomy = await loadResumeTaxonomy(database.db);
		if (!taxonomy) throw new Error('no taxonomy');
		const blocks = RESUME_BLOCKS.map((text, index) => ({ id: resume.blocks[index]?.id ?? '', text }));
		const answer = {
			full_name: [{ raw_text: 'Иванова Мария Сергеевна', block_id: 'p1-b001', quote: 'Иванова Мария Сергеевна' }],
			contacts: [
				{ kind: 'phone', raw_text: '+7 (912) 345-67-89', block_id: 'p1-b002', quote: '+7 (912) 345-67-89' },
				{ kind: 'email', raw_text: 'maria.ivanova@mail.ru', block_id: 'p1-b002', quote: 'maria.ivanova@mail.ru' }
			],
			job_count: 0,
			jobs: [],
			skills: [],
			responsibilities: [],
			education: [],
			languages: [],
			achievements: [],
			soft_skills: [{ raw_text: 'коммуникабельна', block_id: 'p1-b008', quote: 'Коммуникабельна' }]
		};
		const checked = checkResumeAnswer(answer, blocks, resumeLexicon(taxonomy));
		await extract(resume.extractionId, () => ({
			extract: () =>
				Promise.resolve(
					ok({
						model: { modelId: 'extractor-test', modelRevision: null, runtime: 'vllm', params: {} },
						items: checked.items,
						rejected: checked.rejected,
						attempts: 1,
						latencyMs: 1
					})
				)
		}));
		const suggestions = (await ownProfileView(deps(), candidate.subject)).suggestions;
		const byField = (field: string) => {
			const found = suggestions.find((suggestion) => suggestion.field === field);
			if (!found) throw new Error(`no ${field} suggestion`);
			return found;
		};
		expect(suggestions.map((suggestion) => suggestion.field)).toEqual(['full_name', 'phone', 'email', 'soft_skill']);

		// Someone else's suggestion is not found; a decided one cannot be decided again.
		expect(
			(await refusal(decideSuggestion(deps(), other.subject, meta, byField('full_name').id, 'accepted'))).code
		).toBe('not_found');
		await decideSuggestion(deps(), candidate.subject, meta, byField('full_name').id, 'accepted');
		await decideSuggestion(deps(), candidate.subject, meta, byField('soft_skill').id, 'accepted');
		await decideSuggestion(deps(), candidate.subject, meta, byField('phone').id, 'rejected');
		expect(
			(await refusal(decideSuggestion(deps(), candidate.subject, meta, byField('phone').id, 'accepted'))).code
		).toBe('conflict');
		// The address of the profile is the account's: a found one is compared, never taken.
		expect(
			(await refusal(decideSuggestion(deps(), candidate.subject, meta, byField('email').id, 'accepted'))).code
		).toBe('conflict');
		expect(await readOwnProfile(database.db, crypto, candidate.id)).toMatchObject({
			fullName: { last: 'Иванова', first: 'Мария', middle: 'Сергеевна' },
			phone: null,
			softSkillKeys: ['communication']
		});

		// The candidate corrects an accepted value by hand.
		await updateOwnProfile(deps(), candidate.subject, meta, { ...fields, middle_name: null });
		expect((await readOwnProfile(database.db, crypto, candidate.id)).fullName).toEqual({
			last: 'Иванова',
			first: 'Мария',
			middle: null
		});

		// Deleting the resume deletes its suggestions; the accepted values stay the candidate's.
		const store = { delete: () => Promise.resolve() } as unknown as ObjectStore;
		await deleteResume({ db: database.db, store, now }, candidate.subject, resume.resumeDocumentId, meta);
		expect(
			await database.db.select().from(profileSuggestions).where(eq(profileSuggestions.candidateId, candidate.id))
		).toEqual([]);
		expect((await readOwnProfile(database.db, crypto, candidate.id)).fullName?.last).toBe('Иванова');
	});
});

// --- Block list -------------------------------------------------------------------------------------------------------

describe('block list', () => {
	/** A candidate of the catalog with a confirmed category: found by any verified company. */
	async function catalogCandidate() {
		const candidate = await person({ catalog: true });
		const { db } = database;
		const version = await latestPublishedVersion(db);
		if (!version) throw new Error('no taxonomy');
		const [fact] = await db
			.insert(sourceFacts)
			.values({
				candidateId: candidate.id,
				source: 'fsp',
				factType: 'competition_result',
				sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
				trustLevel: 'fsp_verified',
				ownershipBasis: 'operator_confirmed',
				payload: {},
				payloadSha256: randomSha256(),
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				status: 'active'
			})
			.returning();
		if (!fact) throw new Error('fact not inserted');
		const [run] = await db
			.insert(evidenceRuns)
			.values({
				candidateId: candidate.id,
				inputRevision: 1,
				inputSnapshotSha256: randomSha256(),
				inputRefs: { facts: [fact.id], claims: [] },
				taxonomyVersionId: version.id,
				rulesetId: await rulesetOf(version.id),
				asOf: new Date(),
				computedAt: new Date(),
				experienceSummary: {},
				status: 'published'
			})
			.returning();
		if (!run) throw new Error('run not inserted');
		await db.insert(skillInferences).values({
			runId: run.id,
			candidateId: candidate.id,
			skillKey: 'go',
			strength: '0.800',
			strengthBand: 'strong',
			attestation: 'direct',
			badgeTrust: 'fsp_verified',
			contributions: [{ fact_id: fact.id, attestation: 'direct' }]
		});
		await decide(db, candidate.id, { specialization: 'backend', grade: 'middle' });
		return candidate;
	}

	async function rulesetOf(taxonomyVersionId: string): Promise<string> {
		const [ruleset] = await database.db
			.select({ id: categorizationRulesets.id })
			.from(categorizationRulesets)
			.where(eq(categorizationRulesets.taxonomyVersionId, taxonomyVersionId));
		if (!ruleset) throw new Error('the taxonomy release has no categorization rule set');
		return ruleset.id;
	}

	async function employer(name: string) {
		const company = await createCompany(database.db, { displayName: name });
		const member = await createMember(database.db, company.id);
		if (!member.userId) throw new Error('member without user');
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
		return { company, subject };
	}

	const matching = (): MatchingDeps => ({
		db: database.db,
		models: {
			embed: () => Promise.resolve(fail('disabled', 'embed: off in the test', { reason: 'test' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: off in the test', { reason: 'test' }))
		},
		pseudonym: (candidateId, companyId) => `${candidateId}@${companyId}`,
		now,
		testResults: GRADE_DECISION_RESULTS
	});
	const listed = async (subject: AccessSubject, candidateId: string) =>
		(await searchCandidates(matching(), subject, { limit: 100 })).items.some(
			(item) => item.candidateId === candidateId
		);

	it('hides the candidate from the blocked company in the catalog and by the card, and from it only', async () => {
		const candidate = await catalogCandidate();
		const blocked = await employer('Блокируемая компания');
		const other = await employer('Другая компания');
		expect(await listed(blocked.subject, candidate.id)).toBe(true);

		const options = await findCompaniesToBlock(database.db, candidate.id, 'Блокируемая');
		expect(options.map((option) => option.companyId)).toContain(blocked.company.id);
		await blockCompany({ db: database.db, now }, candidate.subject, meta, blocked.company.id);
		// Blocking again changes nothing; a company already blocked is not offered again.
		await blockCompany({ db: database.db, now }, candidate.subject, meta, blocked.company.id);
		expect(
			await database.db
				.select()
				.from(candidateCompanyBlocks)
				.where(eq(candidateCompanyBlocks.candidateId, candidate.id))
		).toHaveLength(1);
		expect(await findCompaniesToBlock(database.db, candidate.id, 'Блокируемая')).toEqual([]);

		expect(await listed(blocked.subject, candidate.id)).toBe(false);
		expect(
			await findInCatalog(matching(), blocked.subject, `${candidate.id}@${blocked.company.id}`, undefined)
		).toBeNull();
		expect(await listed(other.subject, candidate.id)).toBe(true);

		await unblockCompany({ db: database.db, now }, candidate.subject, meta, blocked.company.id);
		expect(await listed(blocked.subject, candidate.id)).toBe(true);
		expect(
			(await refusal(unblockCompany({ db: database.db, now }, candidate.subject, meta, blocked.company.id))).code
		).toBe('not_found');
	});
});

// --- PDF profile and the confirmation of the category -------------------------------------------------------------------

describe('block list: the companies a candidate can find', () => {
	it('offers only the companies of the candidate’s place: a company of a demo session is not found from outside', async () => {
		const candidate = await person();
		const [session] = await database.db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-test', expiresAt: new Date(Date.now() + DAY) })
			.returning({ id: demoSessions.id });
		if (!session) throw new Error('demo session not inserted');
		const inSession = await createCompany(database.db, {
			displayName: 'Сессионная компания',
			demoSessionId: session.id
		});
		expect(await findCompaniesToBlock(database.db, candidate.id, 'Сессионная')).toEqual([]);
		expect((await refusal(blockCompany({ db: database.db, now }, candidate.subject, meta, inSession.id))).code).toBe(
			'not_found'
		);
	});
});

describe('PDF profile and the confirmation of the category', () => {
	const pdfDeps = () => ({ db: database.db, crypto, signer, now });
	const choice = { phone: true, email: true, telegram: true };
	const keySet = receiptKeySet(new Map([['test-1', Buffer.alloc(32, 3)]]));
	const services = () => ({ db: database.db }) as unknown as ApiServices;

	async function checkThroughApi(handle: string) {
		const url = new URL(`${ORIGIN}/api/v1/verify/categories/${handle}`);
		return runOperation(verifyCategoryAttestationOperation, services(), {
			request: new Request(url),
			url,
			params: { handle },
			locals: { requestId: 'req-test', actor: { kind: 'anonymous' } },
			getClientAddress: () => '127.0.0.1'
		});
	}

	async function holderThroughApi(handle: string, body: { full_name: string; nonce: string }) {
		const url = new URL(`${ORIGIN}/api/v1/verify/categories/${handle}/holder`);
		const response = await runOperation(checkAttestationHolderOperation, services(), {
			request: new Request(url, {
				method: 'POST',
				body: JSON.stringify(body),
				headers: { 'content-type': 'application/json' }
			}),
			url,
			params: { handle },
			locals: { requestId: 'req-test', actor: { kind: 'anonymous' } },
			getClientAddress: () => '127.0.0.1'
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as { matches: boolean }).matches;
	}

	it('is refused without a name: the holder commitment is made of it', async () => {
		const candidate = await person();
		expect((await refusal(buildProfilePdf(pdfDeps(), candidate.subject, meta, choice))).code).toBe('conflict');
	});

	it('carries a QR code of a signed confirmation without personal data, whose status follows the category', async () => {
		const candidate = await person();
		await updateOwnProfile(deps(), candidate.subject, meta, fields);
		const junior = await decide(database.db, candidate.id, { specialization: 'backend', grade: 'junior' });

		const input = await buildProfilePdf(pdfDeps(), candidate.subject, meta, choice);
		const [attestation] = await database.db
			.select()
			.from(categoryAttestations)
			.where(eq(categoryAttestations.candidateId, candidate.id));
		if (!attestation) throw new Error('no confirmation issued');
		const url = attestationUrl(ORIGIN, attestation.handle);
		expect(input.categories.map((category) => category.verifyUrl)).toEqual([url]);
		expect(input.contacts.map((contact) => contact.value)).toEqual(['+79123456789', 'maria@example.org', '@maria_dev']);

		// The page: a PDF whose QR code is the code of that address, under a link to it.
		const fonts = {
			regular: await import('node:fs/promises').then((fs) =>
				fs.readFile(new URL('../../src/lib/server/profile/fonts/Inter-Regular.ttf', import.meta.url))
			),
			semibold: await import('node:fs/promises').then((fs) =>
				fs.readFile(new URL('../../src/lib/server/profile/fonts/Inter-SemiBold.ttf', import.meta.url))
			)
		};
		const pdf = (await renderProfilePdf(input, fonts, { compress: false })).toString('latin1');
		expect(pdf.startsWith('%PDF-')).toBe(true);
		expect(pdf).toContain(`/URI (${url})`);
		expect(pdf.match(/ re$/gmu)?.length).toBe(qrModules(url).dark.length);

		// The statement: signed with the key of the receipts, without the name, the contacts or the candidate.
		const response = await checkThroughApi(attestation.handle);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; statement: Record<string, unknown>; signature: string };
		// The decision of the helper serves no cluster: nothing was judged by models, the note is absent.
		expect(body).toMatchObject({
			status: 'valid',
			statement: {
				specialization: 'backend',
				grade: 'junior',
				judgement: {
					rubric_by_models_only: false,
					angoff_provisional: false,
					same_vendor_reviewer: false,
					note: null
				}
			}
		});
		expect(checkReceiptSignature(body.statement, body.signature, 'test-1', keySet)).toBe('valid');
		const published = JSON.stringify(body);
		for (const secret of ['Иванова', 'Мария', '9123456789', 'maria', candidate.id, candidate.userId]) {
			expect(published).not.toContain(secret);
		}

		// The holder: the right name and code match, written as the holder likes; anything else does not.
		const code = (await ownProfileView(deps(), candidate.subject)).attestations[0]?.holderCode;
		if (!code) throw new Error('no holder code');
		expect(await holderThroughApi(attestation.handle, { full_name: 'ИВАНОВА  Мария Сергеевна', nonce: code })).toBe(
			true
		);
		expect(await holderThroughApi(attestation.handle, { full_name: 'Петрова Мария Сергеевна', nonce: code })).toBe(
			false
		);
		expect(
			await holderThroughApi(attestation.handle, { full_name: 'Иванова Мария Сергеевна', nonce: 'a'.repeat(52) })
		).toBe(false);

		// A second PDF of the same assignment gives the same confirmation.
		await buildProfilePdf(pdfDeps(), candidate.subject, meta, choice);
		expect(
			await database.db.select().from(categoryAttestations).where(eq(categoryAttestations.candidateId, candidate.id))
		).toHaveLength(1);

		// The next grade: the old confirmation is a past result naming the grade in force; a new PDF, a new confirmation.
		const middle = await decide(database.db, candidate.id, { specialization: 'backend', grade: 'middle' });
		expect(await verifyAttestation(database.db, attestation.handle)).toMatchObject({
			status: 'superseded',
			currentGrade: { grade: 'middle' }
		});
		await buildProfilePdf(pdfDeps(), candidate.subject, meta, choice);
		const [second] = await database.db
			.select()
			.from(categoryAttestations)
			.where(eq(categoryAttestations.categoryId, middle.applied.categoryId ?? ''));
		if (!second) throw new Error('no confirmation of the new assignment');
		expect((await verifyAttestation(database.db, second.handle))?.status).toBe('valid');

		// The decision of the middle grade is annulled: its confirmation answers `annulled`, the junior one is valid again.
		await invalidate(database.db, candidate.id, middle.decision.id, 'decision_annulled');
		expect(await verifyAttestation(database.db, second.handle)).toMatchObject({
			status: 'annulled',
			annulReason: 'decision_annulled'
		});
		expect((await verifyAttestation(database.db, attestation.handle))?.status).toBe('valid');
		expect(junior.applied.categoryId).toBe(attestation.categoryId);

		// An unknown handle is `404`.
		expect((await checkThroughApi('a'.repeat(26))).status).toBe(404);
	});
});
