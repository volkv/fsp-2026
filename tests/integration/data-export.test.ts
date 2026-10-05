// «Мои данные» (docs/domain.md, sections 6.5, 18.2; contracts 5.5): the candidate downloads everything the platform
// keeps about them — the account and the profile decrypted, facts with claims, consents with their texts, invitations
// with terms and answers, what was handed to which company, the journal of actions about them — and nothing of another
// candidate; a company member is named by the company, never by the account. Every export is `data.exported`.
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { runOperation } from '$lib/server/api/operation';
import type { ApiServices } from '$lib/server/api/services';
import { getMyData } from '$lib/server/api/v1/me';
import { recordAuditEvent } from '$lib/server/audit/record';
import { DATA_EXPORT_FORMAT, exportOwnData, type DataExport } from '$lib/server/candidates/data-export';
import { assignObjection } from '$lib/server/categories/objections';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	assessmentArtifacts,
	assessmentObjections,
	assessmentAttempts,
	assessments,
	assessmentVersions,
	athleteLinks,
	auditEvents,
	authorityChecks,
	candidateCompanyBlocks,
	candidateSurveys,
	categorizationRulesets,
	evidenceRuns,
	claims,
	consentEvents,
	documentAcceptances,
	documentExtractions,
	externalIdentities,
	files,
	fspLevelAssignments,
	gradeDeclarations,
	legalRepresentatives,
	matchRulesets,
	matchScores,
	notificationChannels,
	notificationDeliveries,
	notificationPreferences,
	notifications,
	productPolicies,
	representations,
	resumeDocuments,
	skillInferences,
	sourceFacts,
	users
} from '$lib/server/db/schema';
import type { InvitationDeps } from '$lib/server/invitations/deps';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation } from '$lib/server/invitations/send';
import { COMPONENT_KEYS, matchRulesetParamsSchema } from '$lib/server/matching/params';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { fail } from '$lib/server/ml/result';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser,
	randomSha256
} from '../helpers/factories';

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const EPOCH = new Date(Date.now() - 400 * 86_400_000);
const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const meta = { requestId: 'export-test', ip: '127.0.0.1', userAgent: 'vitest' };

let database: TestDatabase;
let taxonomyVersionId: string;
let matchRulesetId: string;
let categorizationRulesetId: string;
let documents: Record<'pd' | 'catalog' | 'disclosure' | 'telegram' | 'terms', { id: string }>;

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url }));
	const { db } = database;
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	const [matchRuleset] = await db
		.insert(matchRulesets)
		.values({
			version: shippedMatchRuleset.version,
			taxonomyVersionId,
			params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
		})
		.returning();
	if (!matchRuleset) throw new Error('match rule set not inserted');
	matchRulesetId = matchRuleset.id;
	const [categorizationRuleset] = await db
		.insert(categorizationRulesets)
		.values({ version: 1, taxonomyVersionId, params: {} })
		.returning();
	if (!categorizationRuleset) throw new Error('categorization rule set not inserted');
	categorizationRulesetId = categorizationRuleset.id;
	documents = {
		pd: await createPublishedDocument(db, 'pd_processing', { publishedAt: EPOCH }),
		catalog: await createPublishedDocument(db, 'catalog_visibility', { publishedAt: EPOCH }),
		disclosure: await createPublishedDocument(db, 'contact_disclosure', { publishedAt: EPOCH }),
		telegram: await createPublishedDocument(db, 'telegram_notifications', { publishedAt: EPOCH }),
		terms: await createPublishedDocument(db, 'user_agreement', { publishedAt: EPOCH })
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
				stages: ['interview_scheduled'],
				outcome_reason_codes: ['other']
			},
			effectiveFrom: EPOCH
		}
	]);
});

afterAll(async () => {
	await database.drop();
});

const deps = (): InvitationDeps => ({ db: database.db, crypto, now: () => new Date() });

/** `GET /api/v1/me/data` as the candidate's session calls it; a read without an idempotency key needs no Redis. */
async function exportThroughApi(userId: string): Promise<{ status: number; json: Record<string, unknown> }> {
	const services: ApiServices = {
		db: database.db,
		redis: () => Promise.reject(new Error('the export reads no stored answers')),
		crypto,
		mailer: { send: () => Promise.resolve({ ok: true, value: { messageId: 'm' } }) },
		registry: registryNotConfigured,
		models: {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
			extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }))
		},
		receiptSigner: createReceiptSigner({ issuer: 'http://app.test', keyId: 'test-1', seed: Buffer.alloc(32, 5) }),
		appOrigin: 'http://app.test',
		now: () => new Date()
	};
	const actor: Actor = {
		kind: 'session',
		userId,
		sessionHash: randomSha256(),
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: 'csrf'
	};
	const url = new URL('http://app.test/api/v1/me/data');
	const response = await runOperation(getMyData, services, {
		request: new Request(url, { method: 'GET' }),
		url,
		params: {},
		locals: { requestId: 'export-api', actor },
		getClientAddress: () => '127.0.0.1'
	});
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function candidate(name: string) {
	const { db } = database;
	const email = `${name}-${randomBytes(4).toString('hex')}@example.org`;
	const [user] = await db
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			displayName: name
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	const row = await createCandidate(
		db,
		{
			userId: user.id,
			birthDate: '1995-02-03',
			visibility: 'catalog',
			lastNameEnc: crypto.encrypt('Иванова', 'candidates.last_name'),
			firstNameEnc: crypto.encrypt(name, 'candidates.first_name'),
			phoneEnc: crypto.encrypt('+79990001122', 'candidates.phone')
		},
		{ processingConsent: false }
	);
	for (const [kind, document] of [
		['pd_processing', documents.pd],
		['catalog_visibility', documents.catalog]
	] as const) {
		await db.insert(consentEvents).values({
			subjectCandidateId: row.id,
			kind,
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: user.id,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(EPOCH.getTime() + 86_400_000)
		});
	}
	const subject: AccessSubject = {
		userId: user.id,
		via: 'session',
		candidate: { id: row.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { ...row, email, subject };
}

type Person = Awaited<ReturnType<typeof candidate>>;

/**
 * Everything of a candidate kept beside the facts and invitations: FSP ID, notification settings and notifications,
 * accepted agreements, the categorization history with skills and FSP levels, an objection, a blocked company, a
 * resume with its text, a representative with the check of their authority, test attempts with their artifacts, and
 * stored matches. Every free text carries `mark`, so another candidate's rows are found by it.
 */
async function seedTheRest(person: Person, mark: string, scene: { visible: string; hidden: string }) {
	const { db } = database;
	const [identity] = await db
		.insert(externalIdentities)
		.values({
			userId: person.userId,
			issuer: 'https://id.fsp.example',
			subject: `athlete-${mark}`,
			linkedAt: new Date(),
			linkMethod: 'linked_by_user',
			profileClaims: { name: `ФСП ${mark}` }
		})
		.returning();
	if (!identity) throw new Error('identity not inserted');
	await db.insert(athleteLinks).values({
		userId: person.userId,
		source: 'fsp',
		sourceAthleteId: `athlete-${mark}`,
		basisIdentityId: identity.id,
		resolutionMethod: 'subject_equals_athlete_id',
		status: 'active',
		linkedAt: new Date()
	});

	const [telegramConsent] = await db
		.insert(consentEvents)
		.values({
			subjectCandidateId: person.id,
			kind: 'telegram_notifications',
			documentId: documents.telegram.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: person.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date()
		})
		.returning();
	if (!telegramConsent) throw new Error('telegram consent not inserted');
	const chatId = `chat-${mark}`;
	const [channel] = await db
		.insert(notificationChannels)
		.values({
			userId: person.userId,
			kind: 'telegram',
			telegramChatIdEnc: crypto.encrypt(chatId, 'notification_channels.telegram_chat_id'),
			telegramChatHmac: crypto.lookupHmac('telegram_chat', chatId),
			status: 'active',
			consentEventId: telegramConsent.id,
			linkedAt: new Date()
		})
		.returning();
	if (!channel) throw new Error('channel not inserted');
	await db
		.insert(notificationPreferences)
		.values({ userId: person.userId, category: 'hiring', channels: ['telegram'] });
	const objectId = randomUUID();
	const [notification] = await db
		.insert(notifications)
		.values({
			userId: person.userId,
			type: 'objection.decided',
			category: 'account',
			objectType: 'assessment_objection',
			objectId,
			dedupKey: `objection.decided:${objectId}`,
			payload: { objection_id: objectId, mark }
		})
		.returning();
	if (!notification) throw new Error('notification not inserted');
	await db.insert(notificationDeliveries).values({
		notificationId: notification.id,
		channelId: channel.id,
		status: 'sent',
		attempts: 1,
		sentAt: new Date()
	});
	await db.insert(documentAcceptances).values({
		documentId: documents.terms.id,
		userId: person.userId,
		acceptedAt: new Date(),
		ua: `browser-${mark}`
	});

	const [fact] = await db
		.insert(sourceFacts)
		.values({
			candidateId: person.id,
			source: 'resume',
			factType: 'resume_document',
			sourceRecordRef: `resume:${mark}`,
			trustLevel: 'claimed',
			ownershipBasis: 'self_upload',
			payload: { answer: mark },
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		})
		.returning();
	if (!fact) throw new Error('fact not inserted');
	const run = async (status: 'superseded' | 'published', computedAt: Date) => {
		const [row] = await db
			.insert(evidenceRuns)
			.values({
				candidateId: person.id,
				inputRevision: 0,
				inputSnapshotSha256: randomSha256(),
				inputRefs: { facts: [fact.id], claims: [] },
				taxonomyVersionId,
				rulesetId: categorizationRulesetId,
				asOf: computedAt,
				computedAt,
				experienceSummary: {},
				status
			})
			.returning();
		if (!row) throw new Error('run not inserted');
		await db.insert(skillInferences).values({
			runId: row.id,
			candidateId: person.id,
			skillKey: `skill-${mark}`,
			strength: '0.800',
			strengthBand: 'strong',
			attestation: 'claimed',
			contributions: []
		});
		await db
			.insert(fspLevelAssignments)
			.values({ runId: row.id, discipline: `discipline-${mark}`, level: 'L3', basisFactIds: [fact.id] });
		return row;
	};
	await run('superseded', new Date(Date.now() - 86_400_000));
	const current = await run('published', new Date());
	// Categories come from tests: middle, then senior in its place; the candidate objected to the first decision.
	const { decision: middle } = await decide(db, person.id, {
		specialization: 'backend',
		grade: 'middle',
		decidedAt: new Date(Date.now() - 2 * 86_400_000)
	});
	await decide(db, person.id, { specialization: 'backend', grade: 'senior' });
	const openedAt = new Date(Date.now() - 3_600_000);
	await db.insert(assessmentObjections).values({
		candidateId: person.id,
		decisionId: middle.id,
		reason: `возражение ${mark}`,
		openedAt,
		dueAt: new Date(openedAt.getTime() + 30 * 86_400_000),
		status: 'resolved',
		outcome: 'upheld',
		resolution: `ответ оператора ${mark}`,
		resolvedAt: new Date()
	});

	const blocked = await createCompany(db, { displayName: `Блок ${mark}` });
	await db.insert(candidateCompanyBlocks).values({ candidateId: person.id, companyId: blocked.id });

	const [file] = await db
		.insert(files)
		.values({
			ownerUserId: person.userId,
			purpose: 'resume',
			storageKey: `resume/${randomUUID()}`,
			sha256: randomSha256(),
			sizeBytes: 100,
			declaredName: `cv-${mark}.pdf`,
			detectedMime: 'application/pdf',
			status: 'ready'
		})
		.returning();
	if (!file) throw new Error('file not inserted');
	const [resume] = await db
		.insert(resumeDocuments)
		.values({ candidateId: person.id, fileId: file.id, seq: 1, isCurrent: true, parseStatus: 'parsed' })
		.returning();
	if (!resume) throw new Error('resume not inserted');
	await db.insert(documentExtractions).values({
		resumeDocumentId: resume.id,
		extractorName: 'docparse',
		extractorVersion: '1',
		inputSha256: randomSha256(),
		status: 'complete',
		text: `Текст резюме ${mark}`,
		blocks: [],
		flags: {}
	});

	const operator = await createUser(db);
	const [representative] = await db
		.insert(legalRepresentatives)
		.values({
			fullNameEnc: crypto.encrypt(`Представитель ${mark}`, 'legal_representatives.full_name'),
			emailEnc: crypto.encrypt(`parent-${mark}@example.org`, 'legal_representatives.email'),
			emailHmac: crypto.lookupHmac('email', `parent-${mark}@example.org`)
		})
		.returning();
	if (!representative) throw new Error('representative not inserted');
	const [representation] = await db
		.insert(representations)
		.values({
			candidateId: person.id,
			representativeId: representative.id,
			relation: 'parent',
			status: 'authority_verified',
			invitedAt: new Date(Date.now() - 86_400_000),
			contactConfirmedAt: new Date(Date.now() - 3_600_000)
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	await db.insert(authorityChecks).values({
		representationId: representation.id,
		method: 'in_person',
		basisKind: 'birth_certificate',
		basisNote: `свидетельство ${mark}`,
		checkedBy: operator.id,
		checkedAt: new Date(),
		result: 'verified'
	});

	const attempt = async (kind: 'code_task' | 'quiz', status: 'submitted' | 'started') => {
		const [assessment] = await db
			.insert(assessments)
			.values({ kind, title: `${kind} ${mark}`, skillKeys: ['go'] })
			.returning();
		if (!assessment) throw new Error('assessment not inserted');
		const [version] = await db
			.insert(assessmentVersions)
			.values({
				assessmentId: assessment.id,
				version: 1,
				contentSha256: randomSha256(),
				scorer: {},
				levelScale: {},
				coverage: {},
				status: 'published'
			})
			.returning();
		if (!version) throw new Error('assessment version not inserted');
		const [row] = await db
			.insert(assessmentAttempts)
			.values({
				candidateId: person.id,
				versionId: version.id,
				startedAt: new Date(),
				submittedAt: status === 'submitted' ? new Date() : null,
				deadlineAt: new Date(Date.now() + 3_600_000),
				status,
				integritySignals: { entries: [{ at: new Date().toISOString(), stage: 'code_submission', client: null }] }
			})
			.returning();
		if (!row) throw new Error('attempt not inserted');
		return row;
	};
	const code = await attempt('code_task', 'submitted');
	const quiz = await attempt('quiz', 'started');
	await db.insert(assessmentArtifacts).values([
		{
			attemptId: code.id,
			seq: 1,
			kind: 'code_submission',
			content: { language: 'go', source: `package ${mark}` },
			sha256: randomSha256(),
			retentionUntil: '2030-01-01'
		},
		{
			attemptId: quiz.id,
			seq: 1,
			kind: 'quiz_step',
			content: {
				item_id: `item-${mark}`,
				item_version: 1,
				presented_at: new Date().toISOString(),
				answer: 'b',
				correct: true,
				ability_estimate_after: { ability: 0.5, standard_error: 0.3 }
			},
			sha256: randomSha256(),
			retentionUntil: '2030-01-01'
		}
	]);

	const score = (vacancyId: string) => ({
		vacancyId,
		vacancyRevision: 1,
		candidateId: person.id,
		candidateRevision: 0,
		evidenceRunId: current.id,
		matchRulesetId,
		score: '0.640',
		// Only the required skills are computed; every other component is unknown.
		componentStatuses: COMPONENT_KEYS.map((key) => (key === 'required' ? 'c' : 'u')).join(''),
		requiredValue: 0.64,
		computedAt: new Date()
	});
	await db.insert(matchScores).values([score(scene.visible), score(scene.hidden)]);
	return { operatorUserId: operator.id, blockedCompanyId: blocked.id, currentRunId: current.id };
}

describe('the export of own data', () => {
	it('holds everything about the candidate, names companies instead of accounts and is journaled', async () => {
		const { db } = database;
		const anna = await candidate('Анна');
		const boris = await candidate('Борис');
		const [fact] = await db
			.insert(sourceFacts)
			.values({
				candidateId: anna.id,
				source: 'resume',
				factType: 'resume_document',
				sourceRecordRef: 'resume:1',
				trustLevel: 'claimed',
				ownershipBasis: 'self_upload',
				payload: { answer: 'Go' },
				payloadSha256: randomSha256(),
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				status: 'active'
			})
			.returning();
		if (!fact) throw new Error('fact not inserted');
		await db.insert(claims).values({
			candidateId: anna.id,
			factId: fact.id,
			claimType: 'skill_mention',
			rawText: 'Go',
			polarity: 'asserted',
			skillKey: 'go',
			extractor: 'source_mapping',
			status: 'active'
		});

		const company = await createCompany(db, { displayName: 'Северный код' });
		const member = await createMember(db, company.id);
		if (!member.userId) throw new Error('member without user');
		const vacancy = await createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId });
		const companySubject: AccessSubject = {
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
		const sent = await createInvitation(deps(), companySubject, meta, {
			vacancyId: vacancy.id,
			candidateId: anna.id,
			salaryMin: 260_000,
			salaryMax: 340_000,
			message: 'Приглашаем на собеседование'
		});
		await respondToInvitation(deps(), anna.subject, meta, sent.invitationId, {
			termsId: sent.termsId,
			decision: 'accept',
			discloseFields: ['full_name', 'email'],
			disclosureDocumentId: documents.disclosure.id
		});
		await recordAuditEvent(db, {
			action: 'card.viewed',
			outcome: 'success',
			actor: { kind: 'user', userId: member.userId, companyId: company.id },
			subjectCandidateId: anna.id,
			requestId: 'view',
			details: { pseudonym: 'p1', projection: 'catalog' }
		});

		const document = await exportOwnData(db, crypto, {
			userId: anna.userId,
			candidateId: anna.id,
			actor: { kind: 'user', userId: anna.userId },
			requestId: 'export-1',
			ip: '127.0.0.1',
			userAgent: 'vitest',
			channel: 'ui'
		});

		expect(document.format).toBe(DATA_EXPORT_FORMAT);
		expect(document.account).toMatchObject({ id: anna.userId, email: anna.email });
		expect(document.profile).toMatchObject({
			id: anna.id,
			last_name: 'Иванова',
			first_name: 'Анна',
			phone: '+79990001122',
			birth_date: '1995-02-03'
		});
		expect(document.facts).toHaveLength(1);
		expect(document.facts[0]).toMatchObject({
			source: 'resume',
			payload: { answer: 'Go' },
			claims: [{ type: 'skill_mention', raw_text: 'Go', skill_key: 'go' }]
		});
		expect(document.consents.map((event) => `${String(event.kind)}:${String(event.action)}`)).toEqual(
			expect.arrayContaining(['pd_processing:grant', 'catalog_visibility:grant', 'contact_disclosure:grant'])
		);
		expect(document.invitations).toHaveLength(1);
		expect(document.invitations[0]).toMatchObject({
			company: { id: company.id, name: 'Северный код' },
			status: 'accepted',
			terms: [{ version: 1, salary: { min: 260_000, max: 340_000 } }],
			answers: [{ decision: 'accept' }]
		});
		expect(document.disclosures).toEqual([
			expect.objectContaining({ company: { id: company.id, name: 'Северный код' }, fields: ['full_name', 'email'] })
		]);
		expect(document.hiring).toHaveLength(1);
		expect(document.journal).toContainEqual(
			expect.objectContaining({ action: 'card.viewed', actor: { company: 'Северный код' } })
		);
		expect(document.journal).toContainEqual(expect.objectContaining({ action: 'invitation.responded', actor: 'you' }));

		// Nothing of another person: Boris, the company member's account.
		const text = JSON.stringify(document);
		expect(text).not.toContain(boris.id);
		expect(text).not.toContain(boris.userId);
		expect(text).not.toContain('Борис');
		expect(text).not.toContain(member.userId);

		const [journaled] = await db
			.select({ actor: auditEvents.actorUserId, details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'data.exported'), eq(auditEvents.requestId, 'export-1')));
		expect(journaled).toEqual({
			actor: anna.userId,
			details: {
				format: DATA_EXPORT_FORMAT,
				channel: 'ui',
				facts: 1,
				consents: document.consents.length,
				journal: document.journal.length
			}
		});
	});
	it('holds FSP ID, notifications, agreements, the category history, objections, blocks, tests and matches', async () => {
		const { db } = database;
		const anna = await candidate('Анна');
		const boris = await candidate('Борис');
		// The way to a category: two versions of the survey and a declaration with its hint.
		const [, currentSurvey] = await db
			.insert(candidateSurveys)
			.values(
				[1, 2].map((version) => ({
					candidateId: anna.id,
					version,
					catalogVersion: '2026.10.1',
					taxonomyVersionId,
					direction: 'development' as const,
					specialization: version === 1 ? ('frontend' as const) : ('backend' as const),
					declaredSkillKeys: ['go', 'sql'],
					preferences: { work_formats: ['remote'] }
				}))
			)
			.returning({ id: candidateSurveys.id });
		if (!currentSurvey) throw new Error('survey not inserted');
		await db.insert(gradeDeclarations).values({
			candidateId: anna.id,
			surveyId: currentSurvey.id,
			specialization: 'backend',
			grade: 'middle',
			hint: { version: 1, suggested: 'middle', bases: [], caveats: [] },
			declaredAt: new Date()
		});
		const company = await createCompany(db, { displayName: 'Видимый работодатель' });
		const member = await createMember(db, company.id);
		const visible = await createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId });
		const hidden = await createExternalVacancy(db, taxonomyVersionId, {
			title: 'Скрытая вакансия',
			status: 'hidden',
			externalOrg: { name: 'Скрытая организация', source_org_ids: [] }
		});
		const scene = { visible: visible.id, hidden: hidden.id };
		const annas = await seedTheRest(anna, 'anna-mark', scene);
		const boriss = await seedTheRest(boris, 'boris-mark', scene);

		const document = await exportOwnData(db, crypto, {
			userId: anna.userId,
			candidateId: anna.id,
			actor: { kind: 'user', userId: anna.userId },
			requestId: 'export-2',
			ip: '127.0.0.1',
			userAgent: 'vitest',
			channel: 'api'
		});

		expect(document.account).toMatchObject({
			sign_in_providers: [
				expect.objectContaining({ subject: 'athlete-anna-mark', profile_claims: { name: 'ФСП anna-mark' } })
			]
		});
		expect(document.athlete_links).toEqual([
			expect.objectContaining({ source: 'fsp', athlete_id: 'athlete-anna-mark', status: 'active' })
		]);
		expect(document.notification_channels).toEqual([
			expect.objectContaining({ kind: 'telegram', status: 'active', telegram_chat_id: 'chat-anna-mark' })
		]);
		expect(document.notification_preferences).toEqual([
			expect.objectContaining({ category: 'hiring', channels: ['telegram'] })
		]);
		// The categories from tests notified the candidate too.
		const objectionNotifications = document.notifications.filter((row) => row.type === 'objection.decided');
		expect(objectionNotifications).toHaveLength(1);
		expect(objectionNotifications[0]).toMatchObject({
			type: 'objection.decided',
			payload: { mark: 'anna-mark' },
			deliveries: [{ channel: 'telegram', status: 'sent' }]
		});
		expect(document.document_acceptances).toHaveLength(1);
		expect(document.document_acceptances[0]).toMatchObject({
			document: { kind: 'user_agreement' },
			user_agent: 'browser-anna-mark'
		});
		expect(document.evidence.map((run) => run.status)).toEqual(['superseded', 'published']);
		expect(document.evidence[1]).toMatchObject({
			skills: [{ skill_key: 'skill-anna-mark', strength: 0.8, band: 'strong', attestation: 'claimed' }],
			fsp_levels: [{ discipline: 'discipline-anna-mark', level: 'L3' }]
		});
		expect(document.categories).toEqual([
			expect.objectContaining({ specialization: 'backend', grade: 'middle', status: 'superseded' }),
			expect.objectContaining({ specialization: 'backend', grade: 'senior', status: 'active' })
		]);
		expect(document.objections).toEqual([
			expect.objectContaining({
				decision_id: document.categories[0]?.decision_id,
				reason: 'возражение anna-mark',
				status: 'resolved',
				outcome: 'upheld',
				resolution: 'ответ оператора anna-mark'
			})
		]);
		expect(document.matches[0]).toMatchObject({ evidence_run_id: annas.currentRunId });
		expect(document.company_blocks).toEqual([
			expect.objectContaining({ company: { id: annas.blockedCompanyId, name: 'Блок anna-mark' } })
		]);
		expect(document.resumes).toEqual([
			expect.objectContaining({
				file_name: 'cv-anna-mark.pdf',
				extractions: [expect.objectContaining({ status: 'complete', text: 'Текст резюме anna-mark' })]
			})
		]);
		expect(document.representatives).toEqual([
			expect.objectContaining({
				full_name: 'Представитель anna-mark',
				authority_checks: [
					expect.objectContaining({
						result: 'verified',
						basis_note: 'свидетельство anna-mark',
						checked_by: 'platform_staff'
					})
				]
			})
		]);
		const tests = new Map(document.tests.map((test) => [String(test.title), test]));
		expect(tests.get('code_task anna-mark')).toMatchObject({
			integrity_signals: { entries: [expect.objectContaining({ stage: 'code_submission' })] },
			artifacts: [{ kind: 'code_submission', content: { language: 'go', source: 'package anna-mark' } }]
		});
		// A quiz still running does not tell whether an answer was right.
		expect(tests.get('quiz anna-mark')).toMatchObject({
			artifacts: [{ kind: 'quiz_step', content: { item_id: 'item-anna-mark', item_version: 1, answer: 'b' } }]
		});
		expect(JSON.stringify(tests.get('quiz anna-mark'))).not.toContain('correct');
		// Only the vacancy the candidate sees: the hidden one is not revealed by its stored match.
		expect(document.matches).toHaveLength(1);
		expect(document.matches[0]).toMatchObject({
			vacancy: {
				id: visible.id,
				origin: 'own',
				title: visible.title,
				company: { id: company.id, name: 'Видимый работодатель' },
				organization: null
			},
			score: 0.64,
			components: {
				required: { status: 'computed', value: 0.64 },
				salary: { status: 'unknown', value: null }
			}
		});

		// The API gives the same document: its response schema keeps every section.
		const api = await exportThroughApi(anna.userId);
		expect(api.status, JSON.stringify(api.json)).toBe(200);
		expect(api.json.format).toBe('fsp-career-data-export/v3');
		expect(document.surveys.map((survey) => [survey.version, survey.specialization])).toEqual([
			[1, 'frontend'],
			[2, 'backend']
		]);
		expect(document.grade_declarations).toEqual([
			expect.objectContaining({ survey_id: currentSurvey.id, specialization: 'backend', grade: 'middle' })
		]);
		expect(Object.keys(api.json).sort()).toEqual(Object.keys(document).sort());
		const sections = [
			'athlete_links',
			'notification_channels',
			'notification_preferences',
			'surveys',
			'grade_declarations',
			'evidence',
			'categories',
			'objections',
			'company_blocks',
			'matches',
			'document_acceptances',
			'representatives',
			'resumes',
			'tests',
			'notifications'
		] as const satisfies readonly (keyof DataExport)[];
		for (const section of sections) {
			expect(document[section], section).not.toHaveLength(0);
			expect(api.json[section], section).toEqual(document[section]);
		}

		const text = JSON.stringify(document);
		expect(text).not.toContain('boris-mark');
		expect(text).not.toContain(boris.id);
		expect(text).not.toContain(boriss.blockedCompanyId);
		expect(text).not.toContain(annas.operatorUserId);
		expect(text).not.toContain(hidden.id);
		expect(text).not.toContain('Скрытая');
		expect(text).not.toContain(member.userId ?? 'no member account');
	});

	it('names the operator who took an objection into review by role, never by their account', async () => {
		const { db } = database;
		const person = await candidate('Вера');
		const operator = await createUser(db);
		const { decision } = await decide(db, person.id, { specialization: 'backend', grade: 'junior' });
		const openedAt = new Date();
		const [objection] = await db
			.insert(assessmentObjections)
			.values({
				candidateId: person.id,
				decisionId: decision.id,
				reason: 'не согласна',
				openedAt,
				dueAt: new Date(openedAt.getTime() + 30 * 86_400_000),
				status: 'open'
			})
			.returning();
		if (!objection) throw new Error('objection not inserted');
		await assignObjection(db, { objectionId: objection.id, operatorId: operator.id, requestId: 'assign' });

		const document = await exportOwnData(db, crypto, {
			userId: person.userId,
			candidateId: person.id,
			actor: { kind: 'user', userId: person.userId },
			requestId: 'export-assigned',
			ip: '127.0.0.1',
			userAgent: 'vitest',
			channel: 'ui'
		});
		expect(document.journal).toContainEqual(
			expect.objectContaining({ action: 'objection.assigned', actor: 'platform_staff' })
		);
		expect(JSON.stringify(document)).not.toContain(operator.id);
	});
});
