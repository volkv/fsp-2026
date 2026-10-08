// Isolation of demo sessions route by route (docs/domain.md, section 19.3). Every route of the application is in the
// registry below — a matrix case or an exemption with its reason — and the registry is checked against the route files,
// so a new route cannot stay out of the matrix unnoticed. A case runs the route as SvelteKit runs it, for a viewer of
// each place of the stand, and reads what it answers: the answer carries nothing of a place the viewer must not see,
// and, as a check of the case itself, something of every place it must see.
//
// The places: two demo sessions, the stand outside sessions and the originals of the scenario cast (outside sessions,
// `demo_original`). Each holds the same world: a verified company with its owner and a published vacancy, a candidate
// of the catalog invited to it and hired into a process, and the cases of an FSP operator — a company waiting for
// verification, an objection, a representation to check, a vacancy on moderation and a conflict of a birth date. Who sees which place:
// - the catalog, the cards and the vacancies (`scope`): a viewer inside a session sees it and the stand, never another
//   session or the originals; a viewer outside sessions sees the stand and the originals;
// - the cases of the staff (`reach`): a clone operator sees its session only; the operator outside sessions sees the
//   stand and the originals;
// - what a company or a candidate owns (`own`): the own place only.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { publishLegalDocuments, readLegalRelease } from '../../scripts/seed-legal';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import type { Actor } from '$lib/server/access/actor';
import {
	assessmentObjections,
	candidateSurveys,
	categorizationRulesets,
	evidenceRuns,
	companyVerifications,
	competitionPartnerships,
	consentEvents,
	demoSessions,
	gradeDeclarations,
	hiringProcesses,
	invitations,
	invitationTerms,
	legalDocuments,
	legalRepresentatives,
	productPolicies,
	representations,
	skillInferences,
	sourceFacts,
	staffRoles,
	taxonomyVersions
} from '$lib/server/db/schema';
import { grantPartnerPoolConsent } from '$lib/server/candidates/consents';
import { uuidv7 } from '$lib/server/ids';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { insertDecidedAttempt, releaseFixtureBank } from '../helpers/bank';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createUser,
	randomSha256,
	offerTermsRow
} from '../helpers/factories';

// The routes read `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { testEnvironment } = await import('../helpers/environment');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DAY = 86_400_000;
/** The competition every catalog candidate is a finalist of, and every company a partner of. */
const COMPETITION = 'c-matrix-final';
const meta = { requestId: 'demo-isolation-matrix', ip: null, userAgent: 'test' };

// --- The routes ------------------------------------------------------------------------------------------------------

/** Every route module, keyed by its path under `src/routes`; loaded only when a case runs it. */
const ROUTE_MODULES = Object.fromEntries(
	Object.entries(
		import.meta.glob<RouteModule>([
			'../../src/routes/**/+page.server.ts',
			'../../src/routes/**/+layout.server.ts',
			'../../src/routes/**/+server.ts',
			// The glob skips dot directories: `.well-known` and its kind are listed here.
			'../../src/routes/.*/**/+server.ts'
		])
	).map(([path, load]) => [path.replace('../../src/routes/', ''), load])
);

interface RouteModule {
	load?: (event: never) => unknown;
	GET?: (event: never) => Promise<Response>;
	[name: string]: unknown;
}

// --- The places ------------------------------------------------------------------------------------------------------

type PlaceKey = 'first' | 'second' | 'stand' | 'cast';
/** Viewers: the two sessions and the stand; a viewer who is an original of the cast stands outside sessions too. */
const VIEWERS = ['first', 'second', 'stand'] as const;
type ViewerKey = (typeof VIEWERS)[number];
const PLACES: readonly PlaceKey[] = ['first', 'second', 'stand', 'cast'];

type Rule = 'scope' | 'reach' | 'own';
const SEES: Record<Rule, Record<ViewerKey, readonly PlaceKey[]>> = {
	scope: { first: ['first', 'stand'], second: ['second', 'stand'], stand: ['stand', 'cast'] },
	reach: { first: ['first'], second: ['second'], stand: ['stand', 'cast'] },
	own: { first: ['first'], second: ['second'], stand: ['stand'] }
};

interface Place {
	key: PlaceKey;
	session: string | null;
	/** Unique text of the place in names and titles. */
	tag: string;
	companyId: string;
	owner: { userId: string; memberId: string };
	vacancyId: string;
	candidate: { id: string; userId: string; decisionId: string };
	invitationId: string;
	processId: string;
	operatorUserId: string;
	submitted: { companyId: string; verificationId: string };
	objectionId: string;
	/** The candidate's declared grade over a survey (domain 12.2). */
	declarationId: string;
	minor: { id: string; representationId: string };
	moderatedVacancyId: string;
	ageConflictId: string;
	attemptId: string;
	decisionId: string;
	adminUserId: string;
	partnershipId: string;
}

let database: TestDatabase;
let taxonomyVersionId: string;
let rulesetId: string;
let bankReleaseId: string;
let documents: { pd: string; catalog: string; disclosure: string };
let places: Record<PlaceKey, Place>;

async function demoSession(): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
		.returning();
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

/** An account of the place with a real encrypted address, as registration stores it. */
async function account(session: string | null, displayName: string) {
	const crypto = fieldCrypto();
	const email = `${randomBytes(6).toString('hex')}@example.org`;
	return createUser(database.db, {
		demoSessionId: session,
		displayName,
		emailEnc: crypto.encrypt(email, 'users.email'),
		emailHmac: crypto.lookupHmac('email', email)
	});
}

async function grant(candidateId: string, userId: string, kind: 'pd_processing' | 'catalog_visibility') {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind,
		documentId: kind === 'pd_processing' ? documents.pd : documents.catalog,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - DAY)
	});
}

/** A backend developer of the catalog with an FSP result and a category confirmed by a test. */
async function catalogCandidate(session: string | null, original: boolean, tag: string) {
	const { db } = database;
	const user = await account(session, `Кандидат ${tag}`);
	const person = await createCandidate(
		db,
		{
			userId: user.id,
			demoSessionId: session,
			demoOriginal: original,
			birthDate: '1998-04-10',
			visibility: 'catalog',
			profileRevision: 1,
			preferences: { work_formats: ['remote'], region_code: 'RU-MOW' },
			desiredRoleKeys: ['backend']
		},
		{ processingConsent: false }
	);
	await grant(person.id, user.id, 'pd_processing');
	await grant(person.id, user.id, 'catalog_visibility');
	const resultId = `r-${randomBytes(4).toString('hex')}`;
	const [fact] = await db
		.insert(sourceFacts)
		.values({
			candidateId: person.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${resultId}`,
			eventKey: `fsp:competition:${COMPETITION}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {
				result: { id: resultId, competitionId: COMPETITION, place: 2, award: 'prize', status: 'official' },
				competition: {
					id: COMPETITION,
					ekpNumber: null,
					title: 'Чемпионат России по программированию',
					discipline: 'algorithmic',
					level: 'russian_championship',
					stage: 'final',
					startDate: '2025-10-01',
					online: false
				}
			},
			payloadSha256: randomSha256(),
			sourceSnapshotSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
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
			taxonomyVersionId,
			rulesetId,
			asOf: new Date(),
			computedAt: new Date(),
			experienceSummary: {
				total: { min_months: 0, max_months: 0 },
				by_role: {},
				by_skill: {},
				counted_entry_ids: [],
				excluded: []
			},
			status: 'published'
		})
		.returning({ id: evidenceRuns.id });
	if (!run) throw new Error('run not inserted');
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
	const { decision } = await decide(db, person.id, { specialization: 'backend', grade: 'middle' });
	return { id: person.id, userId: user.id, decisionId: decision.id };
}

/** An invitation of the company to the candidate, accepted with the contacts handed over, and its hiring process. */
async function hired(
	company: { id: string; memberId: string },
	vacancyId: string,
	{ candidateId, candidateUserId }: { candidateId: string; candidateUserId: string },
	policies: { invitation: string; hiring: string }
) {
	const { db } = database;
	const invitationId = uuidv7();
	const termsId = uuidv7();
	const sentAt = new Date(Date.now() - 5 * DAY);
	await db.transaction(async (tx) => {
		await tx.insert(invitations).values({
			id: invitationId,
			companyId: company.id,
			candidateId,
			sentByMemberId: company.memberId,
			status: 'accepted',
			currentTermsId: termsId,
			acceptedTermsId: termsId,
			policyId: policies.invitation,
			sentAt
		});
		await tx.insert(invitationTerms).values({
			id: termsId,
			invitationId,
			version: 1,
			...offerTermsRow(),
			vacancyId,
			vacancySnapshot: { title: 'Вакансия' },
			salaryMin: 250_000,
			salaryMax: 350_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			responseDueAt: new Date(sentAt.getTime() + 3 * DAY),
			createdByMemberId: company.memberId,
			createdAt: sentAt
		});
	});
	await db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind: 'contact_disclosure',
		documentId: documents.disclosure,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: candidateUserId,
		scopeCompanyId: company.id,
		scopeInvitationId: invitationId,
		scopeFields: ['full_name', 'email'],
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(sentAt.getTime() + DAY / 2)
	});
	const openedAt = new Date(sentAt.getTime() + DAY);
	const [process] = await db
		.insert(hiringProcesses)
		.values({
			invitationId,
			companyId: company.id,
			candidateId,
			openedAt,
			outcomeDueAt: new Date(openedAt.getTime() + 30 * DAY),
			policyId: policies.hiring
		})
		.returning({ id: hiringProcesses.id });
	if (!process) throw new Error('process not inserted');
	return { invitationId, processId: process.id };
}

async function place(
	key: PlaceKey,
	session: string | null,
	original: boolean,
	policies: { invitation: string; hiring: string }
): Promise<Place> {
	const { db } = database;
	const tag = `${key}-${randomBytes(4).toString('hex')}`;
	const company = await createCompany(db, {
		demoSessionId: session,
		demoOriginal: original,
		displayName: `Компания ${tag}`,
		legalName: `ООО «${tag}»`
	});
	const ownerUser = await account(session, `Рекрутер ${tag}`);
	const owner = await createMember(db, company.id, { userId: ownerUser.id });
	const vacancy = await createOwnVacancy(
		db,
		{ companyId: company.id, memberId: owner.id, taxonomyVersionId },
		{ title: `Вакансия ${tag}`, description: `Разработка сервисов ${tag}` }
	);
	const candidate = await catalogCandidate(session, original, tag);
	const { invitationId, processId } = await hired(
		{ id: company.id, memberId: owner.id },
		vacancy.id,
		{ candidateId: candidate.id, candidateUserId: candidate.userId },
		policies
	);

	const operator = await account(session, `Оператор ${tag}`);
	await db
		.insert(staffRoles)
		.values({ userId: operator.id, role: 'operator', extraPermissions: ['audit.read'], grantedAt: new Date() });

	const submitted = await createCompany(db, {
		status: 'submitted',
		demoSessionId: session,
		demoOriginal: original,
		displayName: `Заявитель ${tag}`,
		legalName: `ООО «Заявитель ${tag}»`
	});
	const applicant = await createMember(db, submitted.id, {
		userId: (await account(session, `Заявитель ${tag}`)).id
	});
	const [verification] = await db
		.insert(companyVerifications)
		.values({ companyId: submitted.id, applicantMemberId: applicant.id, authorityMethod: 'director_self' })
		.returning({ id: companyVerifications.id });
	if (!verification) throw new Error('verification not inserted');

	const openedAt = new Date();
	const [objection] = await db
		.insert(assessmentObjections)
		.values({
			candidateId: candidate.id,
			decisionId: candidate.decisionId,
			reason: `Не согласен ${tag}`,
			openedAt,
			dueAt: new Date(openedAt.getTime() + 30 * DAY),
			status: 'open'
		})
		.returning({ id: assessmentObjections.id });
	if (!objection) throw new Error('objection not inserted');
	const [survey] = await db
		.insert(candidateSurveys)
		.values({
			candidateId: candidate.id,
			version: 1,
			catalogVersion: '2026.10.1',
			taxonomyVersionId,
			direction: 'development',
			specialization: 'backend',
			declaredSkillKeys: ['go'],
			preferences: {}
		})
		.returning({ id: candidateSurveys.id });
	if (!survey) throw new Error('survey not inserted');
	const [declaration] = await db
		.insert(gradeDeclarations)
		.values({
			candidateId: candidate.id,
			surveyId: survey.id,
			specialization: 'backend',
			grade: 'junior',
			hint: { version: 1, suggested: null, bases: [], caveats: [] },
			declaredAt: new Date()
		})
		.returning({ id: gradeDeclarations.id });
	if (!declaration) throw new Error('declaration not inserted');

	const minorUser = await account(session, `Подросток ${tag}`);
	const minor = await createCandidate(db, {
		userId: minorUser.id,
		demoSessionId: session,
		demoOriginal: original,
		birthDate: `${new Date().getUTCFullYear() - 16}-03-01`
	});
	const crypto = fieldCrypto();
	const [representative] = await db
		.insert(legalRepresentatives)
		.values({
			fullNameEnc: crypto.encrypt(`Представитель ${tag}`, 'legal_representatives.full_name'),
			emailEnc: crypto.encrypt(`parent-${tag}@example.org`, 'legal_representatives.email'),
			emailHmac: crypto.lookupHmac('email', `parent-${tag}@example.org`)
		})
		.returning({ id: legalRepresentatives.id });
	if (!representative) throw new Error('representative not inserted');
	const [representation] = await db
		.insert(representations)
		.values({
			candidateId: minor.id,
			representativeId: representative.id,
			relation: 'parent',
			status: 'contact_confirmed',
			invitedAt: new Date(),
			contactConfirmedAt: new Date()
		})
		.returning({ id: representations.id });
	if (!representation) throw new Error('representation not inserted');

	const moderated = await createOwnVacancy(
		db,
		{ companyId: company.id, memberId: owner.id, taxonomyVersionId },
		{
			title: `На модерации ${tag}`,
			status: 'pending_moderation',
			publishedAt: null,
			// A vacancy in moderation carries its case, as the text check that sent it there opened it.
			textCheck: {
				validator_version: 'test',
				result: 'blocked',
				phrases: [],
				warnings_confirmed: null,
				moderation: { opened_at: new Date().toISOString(), resume_to: 'published', decision: null }
			}
		}
	);

	const attempt = await insertDecidedAttempt(db, { candidateId: candidate.id, releaseId: bankReleaseId });

	const admin = await account(session, `Администратор ${tag}`);
	await db.insert(staffRoles).values({ userId: admin.id, role: 'admin', grantedAt: new Date() });

	// The partnership in force, and an ended one: the list of partnerships stays a list.
	const partnership = (status: 'active' | 'ended') => ({
		companyId: company.id,
		competitionRef: COMPETITION,
		competitionSource: 'fsp' as const,
		kind: 'sponsor' as const,
		poolRule: { min_award: 'participant', stages: ['final'] },
		status,
		validFrom: new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10),
		validTo: status === 'ended' ? new Date(Date.now() - DAY).toISOString().slice(0, 10) : null,
		grantedBy: operator.id,
		basis: `Договор ${tag}`
	});
	const [active] = await db
		.insert(competitionPartnerships)
		.values([partnership('active'), partnership('ended')])
		.returning({ id: competitionPartnerships.id });
	if (!active) throw new Error('partnership not inserted');

	const conflictUser = await account(session, `Конфликт ${tag}`);
	const conflict = await createCandidate(db, {
		userId: conflictUser.id,
		demoSessionId: session,
		demoOriginal: original,
		birthDateStatus: 'conflict'
	});

	return {
		key,
		session,
		tag,
		companyId: company.id,
		owner: { userId: ownerUser.id, memberId: owner.id },
		vacancyId: vacancy.id,
		candidate,
		invitationId,
		processId,
		operatorUserId: operator.id,
		submitted: { companyId: submitted.id, verificationId: verification.id },
		objectionId: objection.id,
		declarationId: declaration.id,
		minor: { id: minor.id, representationId: representation.id },
		moderatedVacancyId: moderated.id,
		ageConflictId: conflict.id,
		attemptId: attempt.attemptId,
		decisionId: attempt.decisionId,
		adminUserId: admin.id,
		partnershipId: active.id
	};
}

/** Everything of a place an answer could carry: its ids, its names, its candidates' pseudonyms for the viewer. */
function markersOf(target: Place, viewer: Place): string[] {
	const pseudonym = (candidateId: string) => fieldCrypto().pseudonym(candidateId, viewer.companyId);
	return [
		target.tag,
		target.companyId,
		target.vacancyId,
		target.candidate.id,
		target.candidate.userId,
		target.invitationId,
		target.processId,
		target.operatorUserId,
		target.submitted.companyId,
		target.submitted.verificationId,
		target.objectionId,
		target.declarationId,
		target.minor.id,
		target.minor.representationId,
		target.moderatedVacancyId,
		target.ageConflictId,
		target.attemptId,
		target.adminUserId,
		target.partnershipId,
		pseudonym(target.candidate.id),
		pseudonym(target.minor.id),
		pseudonym(target.ageConflictId)
	];
}

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(`${ROOT}/taxonomy`)));
		await publishPolicies(client, await readPolicyRelease(`${ROOT}/policies`));
		await publishLegalDocuments(client, await readLegalRelease(`${ROOT}/legal`));
	} finally {
		await client.end({ timeout: 5 });
	}
	const { db } = database;
	const [version] = await db.select({ id: taxonomyVersions.id }).from(taxonomyVersions);
	const [ruleset] = await db.select({ id: categorizationRulesets.id }).from(categorizationRulesets);
	if (!version || !ruleset) throw new Error('taxonomy not published');
	taxonomyVersionId = version.id;
	rulesetId = ruleset.id;
	bankReleaseId = (await releaseFixtureBank(db, 'backend')).releaseId;
	const documentOf = async (kind: 'pd_processing' | 'catalog_visibility' | 'contact_disclosure') => {
		const [row] = await db.select({ id: legalDocuments.id }).from(legalDocuments).where(eq(legalDocuments.kind, kind));
		if (!row) throw new Error(`no published ${kind}`);
		return row.id;
	};
	documents = {
		pd: await documentOf('pd_processing'),
		catalog: await documentOf('catalog_visibility'),
		disclosure: await documentOf('contact_disclosure')
	};
	const policyOf = async (kind: 'invitation_policy' | 'hiring_policy') => {
		const [row] = await db
			.select({ id: productPolicies.id })
			.from(productPolicies)
			.where(eq(productPolicies.kind, kind));
		if (!row) throw new Error(`no ${kind}`);
		return row.id;
	};
	const policies = { invitation: await policyOf('invitation_policy'), hiring: await policyOf('hiring_policy') };
	places = {
		first: await place('first', await demoSession(), false, policies),
		second: await place('second', await demoSession(), false, policies),
		stand: await place('stand', null, false, policies),
		cast: await place('cast', null, true, policies)
	};
	// Every finalist joins the pools of the partners their place can see.
	const [poolDocument] = await db
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(eq(legalDocuments.kind, 'partner_pool'));
	if (!poolDocument) throw new Error('no published partner_pool');
	for (const key of PLACES) {
		const { candidate } = places[key];
		await grantPartnerPoolConsent(
			db,
			{
				userId: candidate.userId,
				via: 'session',
				candidate: { id: candidate.id, status: 'active' },
				membership: null,
				staff: { operator: false, admin: false, extraPermissions: [] }
			},
			meta,
			{ documentId: poolDocument.id, competitionRef: COMPETITION }
		);
	}
}, 180_000);

afterAll(async () => {
	await closeDb();
	await database.drop();
});

// --- Running a route -------------------------------------------------------------------------------------------------

interface Answer {
	ok: boolean;
	status: number;
	text: string;
}

let requests = 0;

function event(userId: string, path: string, params: Record<string, string>) {
	const url = new URL(`http://localhost:57173${path}`);
	const actor: Actor = {
		kind: 'session',
		userId,
		sessionHash: randomSha256(),
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: 'csrf'
	};
	return {
		url,
		params,
		request: new Request(url),
		locals: { requestId: `matrix-${++requests}`, actor },
		route: { id: path },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		parent: () => Promise.resolve({}),
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {}, serialize: () => '' }
	};
}

async function runRoute(route: string, userId: string, path: string, params: Record<string, string>): Promise<Answer> {
	const importer = ROUTE_MODULES[route];
	if (!importer) throw new Error(`no route ${route}`);
	const module = await importer();
	const input = event(userId, path, params) as never;
	if (module.GET) {
		const response = await module.GET(input);
		return { ok: response.ok, status: response.status, text: await response.text() };
	}
	if (!module.load) throw new Error(`route ${route} neither loads nor answers GET`);
	try {
		return { ok: true, status: 200, text: JSON.stringify(await module.load(input)) };
	} catch (error) {
		if (isHttpError(error)) return { ok: false, status: error.status, text: JSON.stringify(error.body) };
		if (isRedirect(error)) return { ok: false, status: error.status, text: error.location };
		throw error;
	}
}

// --- The registry ----------------------------------------------------------------------------------------------------

type Role = 'company' | 'candidate' | 'operator' | 'admin';

const USERS: Record<Role, (who: Place) => string> = {
	company: (who) => who.owner.userId,
	candidate: (who) => who.candidate.userId,
	operator: (who) => who.operatorUserId,
	admin: (who) => who.adminUserId
};

/** One answer per viewer: a list or a page that reads rows of many places. */
interface ListCase {
	kind: 'list';
	role: Role;
	rule: Rule;
	path: (viewer: Place) => string;
	params?: (viewer: Place) => Record<string, string>;
}

/** One answer per viewer and place: a page or a resource named by the id of a row of that place. */
interface TargetCase {
	kind: 'target';
	role: Role;
	rule: Rule;
	path: (viewer: Place, target: Place) => string;
	params: (viewer: Place, target: Place) => Record<string, string>;
}

/** A route out of the matrix, and why. The reason `writes` is checked: such a route neither loads nor answers GET. */
interface Exempt {
	kind: 'exempt';
	reason: string;
}

type Entry = ListCase | TargetCase | Exempt;

const list = (role: Role, rule: Rule, path: ListCase['path'], params?: ListCase['params']): ListCase => ({
	kind: 'list',
	role,
	rule,
	path,
	...(params ? { params } : {})
});
const target = (role: Role, rule: Rule, path: TargetCase['path'], params: TargetCase['params']): TargetCase => ({
	kind: 'target',
	role,
	rule,
	path,
	params
});
const exempt = (reason: string): Exempt => ({ kind: 'exempt', reason });
const WRITES = exempt('writes');

const pseudonymFor = (viewer: Place, candidateId: string) => fieldCrypto().pseudonym(candidateId, viewer.companyId);

const REGISTRY: Record<string, Entry> = {
	// The catalog and the cards of a company.
	'(app)/company/(member)/candidates/+page.server.ts': list('company', 'scope', () => '/company/candidates'),
	'(app)/company/(member)/candidates/[pseudonym]/+page.server.ts': target(
		'company',
		'scope',
		(v, t) => `/company/candidates/${pseudonymFor(v, t.candidate.id)}`,
		(v, t) => ({ pseudonym: pseudonymFor(v, t.candidate.id) })
	),
	'(app)/company/(member)/vacancies/[id]/candidates/+page.server.ts': list(
		'company',
		'scope',
		(v) => `/company/vacancies/${v.vacancyId}/candidates`,
		(v) => ({ id: v.vacancyId })
	),
	'(app)/company/(member)/vacancies/[id]/candidates/[pseudonym]/+page.server.ts': target(
		'company',
		'scope',
		(v, t) => `/company/vacancies/${v.vacancyId}/candidates/${pseudonymFor(v, t.candidate.id)}`,
		(v, t) => ({ id: v.vacancyId, pseudonym: pseudonymFor(v, t.candidate.id) })
	),
	'api/v1/catalog/candidates/+server.ts': list('company', 'scope', () => '/api/v1/catalog/candidates?limit=100'),
	'api/v1/catalog/comparison/+server.ts': target(
		'company',
		'scope',
		(v, t) => `/api/v1/catalog/comparison?vacancy_id=${v.vacancyId}&pseudonym=${pseudonymFor(v, t.candidate.id)}`,
		() => ({})
	),
	'api/v1/candidates/[pseudonym]/+server.ts': target(
		'company',
		'scope',
		(v, t) => `/api/v1/candidates/${pseudonymFor(v, t.candidate.id)}`,
		(v, t) => ({ pseudonym: pseudonymFor(v, t.candidate.id) })
	),
	'api/v1/vacancies/[vacancy_id]/matches/+server.ts': list(
		'company',
		'scope',
		(v) => `/api/v1/vacancies/${v.vacancyId}/matches?limit=100`,
		(v) => ({ vacancy_id: v.vacancyId })
	),
	'api/v1/vacancies/[vacancy_id]/matches/[pseudonym]/+server.ts': target(
		'company',
		'scope',
		(v, t) => `/api/v1/vacancies/${v.vacancyId}/matches/${pseudonymFor(v, t.candidate.id)}`,
		(v, t) => ({ vacancy_id: v.vacancyId, pseudonym: pseudonymFor(v, t.candidate.id) })
	),

	// What a company owns: its vacancies, invitations and hiring.
	'(app)/company/(member)/vacancies/+page.server.ts': list('company', 'own', () => '/company/vacancies'),
	'(app)/company/(member)/vacancies/[id]/+page.server.ts': target(
		'company',
		'own',
		(_, t) => `/company/vacancies/${t.vacancyId}`,
		(_, t) => ({ id: t.vacancyId })
	),
	'(app)/company/(member)/invitations/+page.server.ts': list('company', 'own', () => '/company/invitations'),
	'(app)/company/(member)/invitations/[id]/+page.server.ts': target(
		'company',
		'own',
		(_, t) => `/company/invitations/${t.invitationId}`,
		(_, t) => ({ id: t.invitationId })
	),
	'(app)/company/(member)/hiring/+page.server.ts': list('company', 'own', () => '/company/hiring'),
	'(app)/company/(member)/+layout.server.ts': list('company', 'own', () => '/company/vacancies'),
	'(app)/company/(member)/profile/+page.server.ts': list('company', 'own', () => '/company/profile'),
	'(app)/company/(member)/profile/team/+page.server.ts': list('company', 'own', () => '/company/profile/team'),
	'api/v1/vacancies/+server.ts': list('company', 'scope', () => '/api/v1/vacancies?limit=100'),
	'api/v1/vacancies/[vacancy_id]/+server.ts': target(
		'company',
		'scope',
		(_, t) => `/api/v1/vacancies/${t.vacancyId}`,
		(_, t) => ({ vacancy_id: t.vacancyId })
	),
	'api/v1/companies/[company_id]/+server.ts': target(
		'company',
		'own',
		(_, t) => `/api/v1/companies/${t.companyId}`,
		(_, t) => ({ company_id: t.companyId })
	),
	'api/v1/companies/[company_id]/vacancies/+server.ts': target(
		'company',
		'own',
		(_, t) => `/api/v1/companies/${t.companyId}/vacancies`,
		(_, t) => ({ company_id: t.companyId })
	),
	'api/v1/companies/[company_id]/members/+server.ts': target(
		'company',
		'own',
		(_, t) => `/api/v1/companies/${t.companyId}/members`,
		(_, t) => ({ company_id: t.companyId })
	),
	'api/v1/invitations/+server.ts': list('company', 'own', () => '/api/v1/invitations'),
	'api/v1/invitations/[invitation_id]/+server.ts': target(
		'company',
		'own',
		(_, t) => `/api/v1/invitations/${t.invitationId}`,
		(_, t) => ({ invitation_id: t.invitationId })
	),
	'api/v1/hiring/[process_id]/+server.ts': target(
		'company',
		'own',
		(_, t) => `/api/v1/hiring/${t.processId}`,
		(_, t) => ({ process_id: t.processId })
	),

	// The pool of a partnership: the finalists who named the company in their consent. A finalist names the partners
	// their own place sees, so a pool of a session holds its finalists only — the reach of the place.
	'(app)/company/(member)/partner-pools/+page.server.ts': list('company', 'own', () => '/company/partner-pools'),
	'(app)/company/(member)/partner-pools/[partnershipId]/+page.server.ts': list(
		'company',
		'reach',
		(v) => `/company/partner-pools/${v.partnershipId}`,
		(v) => ({ partnershipId: v.partnershipId })
	),
	'api/v1/partner-pools/[partnership_id]/candidates/+server.ts': list(
		'company',
		'reach',
		(v) => `/api/v1/partner-pools/${v.partnershipId}/candidates`,
		(v) => ({ partnership_id: v.partnershipId })
	),
	'api/v1/invitations/[invitation_id]/messages/+server.ts': target(
		'company',
		'own',
		(_, t) => `/api/v1/invitations/${t.invitationId}/messages`,
		(_, t) => ({ invitation_id: t.invitationId })
	),
	'api/v1/invitations/[invitation_id]/contacts/+server.ts': target(
		'company',
		'own',
		(_, t) => `/api/v1/invitations/${t.invitationId}/contacts`,
		(_, t) => ({ invitation_id: t.invitationId })
	),

	// The candidate's side: vacancies offered, and what is addressed to the candidate.
	'(app)/me/vacancies/+page.server.ts': list('candidate', 'scope', () => '/me/vacancies'),
	'api/v1/me/matches/+server.ts': list('candidate', 'scope', () => '/api/v1/me/matches?limit=100'),
	'(app)/me/tests/+page.server.ts': list('candidate', 'own', () => '/me/tests'),
	'(app)/me/tests/attempts/[attemptId]/+page.server.ts': target(
		'candidate',
		'own',
		(_, t) => `/me/tests/attempts/${t.attemptId}`,
		(_, t) => ({ attemptId: t.attemptId })
	),
	'(app)/me/tests/decisions/[decisionId]/+page.server.ts': target(
		'candidate',
		'own',
		(_, t) => `/me/tests/decisions/${t.decisionId}`,
		(_, t) => ({ decisionId: t.decisionId })
	),
	'api/v1/me/tests/[attempt_id]/+server.ts': target(
		'candidate',
		'own',
		(_, t) => `/api/v1/me/tests/${t.attemptId}`,
		(_, t) => ({ attempt_id: t.attemptId })
	),
	'api/v1/me/tests/decisions/[decision_id]/+server.ts': target(
		'candidate',
		'own',
		(_, t) => `/api/v1/me/tests/decisions/${t.decisionId}`,
		(_, t) => ({ decision_id: t.decisionId })
	),
	'(app)/me/category/+page.server.ts': list('candidate', 'own', () => '/me/category'),
	'api/v1/me/categories/+server.ts': list('candidate', 'own', () => '/api/v1/me/categories'),
	'(app)/me/profile/+page.server.ts': list('candidate', 'own', () => '/me/profile'),
	'(app)/me/invitations/+page.server.ts': list('candidate', 'own', () => '/me/invitations'),
	'(app)/me/invitations/[id]/+page.server.ts': target(
		'candidate',
		'own',
		(_, t) => `/me/invitations/${t.invitationId}`,
		(_, t) => ({ id: t.invitationId })
	),

	// The cases of an FSP operator.
	'(app)/operator/companies/+page.server.ts': list('operator', 'reach', () => '/operator/companies'),
	'(app)/operator/companies/[id]/+page.server.ts': target(
		'operator',
		'reach',
		(_, t) => `/operator/companies/${t.companyId}`,
		(_, t) => ({ id: t.companyId })
	),
	'(app)/operator/companies/requests/[id]/+page.server.ts': target(
		'operator',
		'reach',
		(_, t) => `/operator/companies/requests/${t.submitted.verificationId}`,
		(_, t) => ({ id: t.submitted.verificationId })
	),
	'(app)/operator/objections/+page.server.ts': list('operator', 'reach', () => '/operator/objections'),
	'api/v1/operator/objections/+server.ts': list('operator', 'reach', () => '/api/v1/operator/objections'),
	// The case reads the objected decision from the engine of the test, which is not wired in yet.
	'(app)/operator/objections/[id]/+page.server.ts': exempt(
		'case of one objection, within the reach — demo-isolation.test.ts'
	),
	'(app)/operator/representatives/+page.server.ts': list('operator', 'reach', () => '/operator/representatives'),
	'(app)/operator/representatives/[id]/+page.server.ts': target(
		'operator',
		'reach',
		(_, t) => `/operator/representatives/${t.minor.representationId}`,
		(_, t) => ({ id: t.minor.representationId })
	),
	'(app)/operator/vacancies/+page.server.ts': list('operator', 'reach', () => '/operator/vacancies'),
	'(app)/operator/vacancies/[id]/+page.server.ts': target(
		'operator',
		'reach',
		(_, t) => `/operator/vacancies/${t.moderatedVacancyId}`,
		(_, t) => ({ id: t.moderatedVacancyId })
	),
	'api/v1/operator/moderation/vacancies/+server.ts': list(
		'operator',
		'reach',
		() => '/api/v1/operator/moderation/vacancies'
	),
	'(app)/operator/ages/+page.server.ts': list('operator', 'reach', () => '/operator/ages'),
	'(app)/operator/ages/[id]/+page.server.ts': target(
		'operator',
		'reach',
		(_, t) => `/operator/ages/${t.ageConflictId}`,
		(_, t) => ({ id: t.ageConflictId })
	),
	'api/v1/operator/ages/+server.ts': list('operator', 'reach', () => '/api/v1/operator/ages'),
	'(app)/operator/assessments/+page.server.ts': list('operator', 'reach', () => '/operator/assessments?filter=all'),
	'(app)/operator/assessments/[id]/+page.server.ts': target(
		'operator',
		'reach',
		(_, t) => `/operator/assessments/${t.attemptId}`,
		(_, t) => ({ id: t.attemptId })
	),
	'api/v1/operator/assessments/attempts/+server.ts': list(
		'operator',
		'reach',
		() => '/api/v1/operator/assessments/attempts?filter=all'
	),
	'(app)/operator/partnerships/+page.server.ts': list('operator', 'reach', () => '/operator/partnerships'),
	'(app)/admin/staff/+page.server.ts': list('admin', 'reach', () => '/admin/staff'),
	// The journal names what the accounts of a session did, the rows of the stand they looked at included; which
	// events a clone reads is checked event by event in demo-actor.test.ts.
	'(app)/operator/audit/+page.server.ts': exempt('journal: events of the own accounts — demo-actor.test.ts'),
	'(app)/admin/audit/+page.server.ts': exempt('journal: events of the own accounts — demo-actor.test.ts'),

	// Files of the cases: read from the storage by the case they belong to, within the same reach as the case.
	'(app)/operator/companies/requests/[id]/evidence/+server.ts': exempt('case file — demo-actor.test.ts'),
	'(app)/operator/representatives/[id]/evidence/+server.ts': exempt('case file — demo-actor.test.ts'),
	'(app)/company/(member)/invitations/[id]/resume/+server.ts': exempt(
		'resume disclosed to the own company — storage-access.test.ts'
	),
	'(app)/company/(member)/applications/[id]/resume/+server.ts': exempt(
		'resume disclosed to the own company — storage-access.test.ts'
	),
	'(app)/operator/fsp-import/files/[id]/+server.ts': exempt('batch file of the stand — demo-actor.test.ts'),
	'(app)/operator/fsp-import/+page.server.ts': exempt('batches of the stand, none to a clone — demo-actor.test.ts'),

	// Numbers without rows: the first screens count the cases of the reach, the aggregates count outside sessions.
	'(app)/operator/+page.server.ts': exempt('counts of the reach — demo-isolation.test.ts'),
	'(app)/operator/outcomes/+page.server.ts': exempt('aggregate outside sessions — funnel.test.ts'),
	'api/v1/operator/funnel/+server.ts': exempt('aggregate outside sessions — funnel.test.ts'),
	'(app)/operator/skills/+page.server.ts': exempt('aggregate outside sessions — catalog-run-in-force.test.ts'),
	'api/v1/catalog/market/+server.ts': exempt('aggregate outside sessions — market-snapshots.test.ts'),
	'+page.server.ts': exempt('reference counts, no accounts or sessions — landing-metrics.test.ts'),

	// Letters of the demo session to its own accounts.
	'(app)/demo/mail/+page.server.ts': exempt('letters of the own session — demo-letters.test.ts'),
	'(app)/demo/mail/[id]/+page.server.ts': exempt('letters of the own session — demo-letters.test.ts'),

	// Checks of a role or of a session, and headers, without rows.
	'+layout.server.ts': exempt('the signed-in account itself'),
	'(app)/operator/+layout.server.ts': exempt('role check, no rows'),
	'(app)/admin/+layout.server.ts': exempt('role check, no rows'),
	'(app)/company/+layout.server.ts': exempt('headers only'),
	'(app)/me/+layout.server.ts': exempt('headers only'),
	'(auth)/+layout.server.ts': exempt('headers only'),
	'(app)/company/+page.server.ts': exempt('redirect only'),
	'(app)/me/+page.server.ts': exempt('redirect only'),

	// The shared reference of the stand: the same for every place, no row of a candidate, vacancy or company.
	'(app)/admin/+page.server.ts': exempt('model modes of the stand'),
	'(app)/admin/documents/+page.server.ts': exempt('legal documents of the stand'),
	'(app)/admin/documents/[id]/+page.server.ts': exempt('legal documents of the stand'),
	'(app)/admin/policies/+page.server.ts': exempt('product policies of the stand'),
	'(app)/admin/quality/+page.server.ts': exempt('quality runs of the models'),
	'(app)/admin/quality/[id]/+page.server.ts': exempt('quality runs of the models'),
	'(app)/admin/quality/[id]/report/+server.ts': exempt('quality runs of the models'),
	'(app)/admin/rules/+page.server.ts': exempt('rule sets of the stand'),
	'(app)/admin/taxonomy/+page.server.ts': exempt('taxonomy of the stand'),
	'api/v1/taxonomy/grades/+server.ts': exempt('taxonomy of the stand'),
	'api/v1/taxonomy/roles/+server.ts': exempt('taxonomy of the stand'),
	'api/v1/taxonomy/skills/+server.ts': exempt('taxonomy of the stand'),
	'api/v1/taxonomy/work-terms/+server.ts': exempt('taxonomy of the stand'),
	'api/docs/+server.ts': exempt('API documentation'),
	'api/docs/[asset]/+server.ts': exempt('API documentation'),
	'api/v1/openapi.json/+server.ts': exempt('API documentation'),
	'api/health/+server.ts': exempt('health of the services'),
	'(auth)/documents/[kind]/+page.server.ts': exempt('legal documents of the stand'),

	// The subject's own account and settings: read by the signed-in account, never by an id of another row.
	'(app)/account/delete/+page.server.ts': exempt('own account'),
	'(app)/account/deleted/+page.server.ts': exempt('own account'),
	'(app)/account/notifications/+page.server.ts': exempt('own account'),
	'(app)/notifications/+page.server.ts': exempt('own notifications'),
	'(app)/notifications/[id]/+page.server.ts': exempt('own notifications'),
	'(auth)/account/+page.server.ts': exempt('own account'),
	'(auth)/account/fsp-import/+page.server.ts': exempt('own account'),
	'(auth)/account/reauth/+page.server.ts': exempt('own account'),
	'(app)/me/consents/+page.server.ts': exempt('own consents'),
	// The partners of the pool the candidate is offered to join: only the companies within the reach of the session.
	'api/v1/me/consents/+server.ts': list('candidate', 'scope', () => '/api/v1/me/consents'),
	'api/v1/me/account/deletion/+server.ts': exempt('own account'),
	'api/v1/me/resumes/+server.ts': exempt('own resume'),
	'api/v1/me/resumes/current/+server.ts': exempt('own resume'),
	'(app)/me/export/+page.server.ts': exempt('own export, the form only'),
	// The export of a candidate outside sessions names every company that looked at the card or got a receipt,
	// the clone companies of demo sessions among them: whether a person outside sessions is told of a demo visitor
	// is not decided by domain 19.3 yet, so the export is out of the matrix until it is.
	'(app)/me/export/download/+server.ts': exempt('open: companies of demo sessions in the export'),
	'api/v1/me/data/+server.ts': exempt('open: companies of demo sessions in the export'),
	'(app)/me/resume/+page.server.ts': exempt('own resume'),
	'(app)/me/settings/+page.server.ts': exempt('own settings'),
	'(app)/me/visibility/+page.server.ts': exempt(
		'own settings; the company search keeps the demo scope of the candidate — candidate-profile.test.ts'
	),
	'(app)/me/profile/pdf/+server.ts': exempt('own PDF profile: own fields and own confirmations of categories'),
	'api/v1/me/profile/+server.ts': exempt('own profile fields'),
	'api/v1/me/company-blocks/+server.ts': exempt('own block list'),
	'api/v1/me/company-blocks/search/+server.ts': exempt(
		'companies by name in the demo scope of the candidate — candidate-profile.test.ts'
	),
	'(app)/admin/bank/+page.server.ts': exempt('bank releases of the stand'),
	'api/v1/admin/bank-releases/+server.ts': exempt('bank releases of the stand'),
	'(app)/company/(member)/profile/keys/+page.server.ts': exempt('own API keys'),
	'(app)/company/(member)/vacancies/new/+page.server.ts': exempt('form of a new vacancy'),
	'(app)/company/join/+page.server.ts': exempt('own membership'),
	'api/v1/companies/[company_id]/api-keys/+server.ts': exempt('own API keys'),
	'api/v1/company/profile/+server.ts': exempt('the profile of the own company'),
	// Trust, complaints and outgoing events (domain 5.7, 13.13).
	'api/v1/company/trust/+server.ts': exempt('facts of the own company'),
	'(app)/company/(member)/profile/integrations/+page.server.ts': exempt('own event subscriptions'),
	'api/v1/companies/[company_id]/event-subscriptions/+server.ts': exempt('own event subscriptions'),
	'api/v1/companies/[company_id]/event-subscriptions/huntflow/+server.ts': WRITES,
	'api/v1/companies/[company_id]/event-subscriptions/[subscription_id]/+server.ts': WRITES,
	'api/v1/companies/[company_id]/event-subscriptions/[subscription_id]/secret/+server.ts': WRITES,
	'api/v1/companies/[company_id]/event-subscriptions/[subscription_id]/ping/+server.ts': WRITES,
	'api/v1/companies/[company_id]/event-subscriptions/[subscription_id]/deliveries/+server.ts': exempt(
		'deliveries of an own subscription'
	),
	'api/v1/invitations/[invitation_id]/complaint/+server.ts': exempt(
		'own complaint about an own offer, another one is 404 — complaints.test.ts'
	),
	'(app)/operator/complaints/+page.server.ts': exempt('complaints within the reach — complaints.test.ts'),
	'(app)/operator/complaints/[id]/+page.server.ts': exempt('a complaint within the reach — complaints.test.ts'),
	'api/v1/operator/complaints/+server.ts': exempt('complaints within the reach — complaints.test.ts'),
	'api/v1/operator/complaints/[complaint_id]/+server.ts': exempt('a complaint within the reach — complaints.test.ts'),
	'api/v1/operator/complaints/[complaint_id]/decision/+server.ts': WRITES,
	'(app)/company/(member)/needs/+page.server.ts': exempt('needs of the own company — needs.test.ts'),
	'(app)/company/(member)/needs/[id]/+page.server.ts': exempt(
		'a need of the own company, another one is 404 — needs.test.ts'
	),
	'api/v1/needs/+server.ts': exempt('needs of the own company — api-access.test.ts'),
	'api/v1/needs/[need_id]/+server.ts': exempt('a need of the own company, another one is 404 — api-access.test.ts'),
	'api/v1/needs/[need_id]/categories/+server.ts': exempt('counts through canShow, which keeps the demo scope'),
	'(app)/company/(member)/shortlists/[id]/+page.server.ts': exempt(
		'a shortlist of the own company, another one is 404; its candidates go through the search, which keeps the demo scope — shortlists.test.ts'
	),
	'(app)/company/(member)/shortlists/[id]/evaluate/+page.server.ts': exempt(
		'a shortlist of the own company; both lists of the comparison go through the search, which keeps the demo scope'
	),
	'api/v1/needs/[need_id]/shortlists/+server.ts': exempt(
		'shortlists of the own need, another one is 404 — shortlists.test.ts'
	),
	'api/v1/shortlists/[shortlist_id]/+server.ts': exempt(
		'a shortlist of the own company ranked through the search, which keeps the demo scope — shortlists.test.ts'
	),
	'api/v1/shortlists/[shortlist_id]/revisions/+server.ts': exempt('a step of the own shortlist — shortlists.test.ts'),
	'api/v1/shortlists/[shortlist_id]/marks/[pseudonym]/+server.ts': exempt(
		'a candidate the company sees in the catalog (findInCatalog keeps the demo scope) — shortlists.test.ts'
	),
	'api/v1/shortlists/[shortlist_id]/what-if/+server.ts': exempt(
		'candidates through the search; the range only by a cohort of the candidates the company sees — shortlists.test.ts'
	),
	'api/v1/shortlists/[shortlist_id]/evaluations/+server.ts': exempt(
		'both lists go through the search, which keeps the demo scope — shortlists.test.ts'
	),
	'api/v1/shortlists/[shortlist_id]/evaluations/[evaluation_id]/judgement/+server.ts': exempt(
		'positions of an own evaluation, no candidate is read — shortlists.test.ts'
	),

	// Sign-in, registration and the links sent by mail: bound to a token, not to a place.
	'(auth)/login/+page.server.ts': exempt('sign-in'),
	'(auth)/register/+page.server.ts': exempt('registration'),
	'(auth)/verify-email/+page.server.ts': exempt('link sent by mail'),
	'(auth)/password/reset/+page.server.ts': exempt('link sent by mail'),
	'(auth)/password/forgot/+page.server.ts': WRITES,
	'(auth)/onboarding/+page.server.ts': exempt('own onboarding'),
	'(auth)/onboarding/consent/+page.server.ts': exempt('own onboarding'),
	'(auth)/onboarding/representative/+page.server.ts': exempt('own onboarding'),
	'(auth)/onboarding/survey/+page.server.ts': exempt('own onboarding'),
	'(auth)/onboarding/grade/+page.server.ts': exempt('own onboarding'),
	'api/v1/catalog/categories/+server.ts': exempt('catalog of categories of the stand'),
	'api/v1/me/grade-hint/+server.ts': exempt('own grade hint: texts over the own evidence'),
	'api/v1/me/grade-options/+server.ts': exempt('own grade options: grades of the catalog only'),
	'(auth)/representative/confirm/+page.server.ts': exempt('link sent by mail'),
	'(auth)/representative/consent/+page.server.ts': exempt('link sent by mail'),
	'(auth)/representative/disclosure/+page.server.ts': exempt('link sent by mail'),
	'(auth)/representative/letter/+page.server.ts': WRITES,
	'(auth)/demo/+page.server.ts': exempt('opens a demo session'),
	'(auth)/demo/resume/+page.server.ts': exempt('opens a demo session'),
	'auth/fsp/+server.ts': exempt('sign-in'),
	'auth/fsp/callback/+server.ts': exempt('sign-in'),
	'auth/fsp/link/+server.ts': WRITES,
	'auth/logout/+server.ts': WRITES,
	// A receipt is checked by its handle, a capability issued to one audience; it names no place.
	'verify/[handle]/+page.server.ts': exempt('receipt by its handle'),
	'api/v1/verify/[handle]/+server.ts': exempt('receipt by its handle'),
	// A confirmation of a category is checked by its handle, given away in a PDF; it names no place.
	'verify/categories/[handle]/+page.server.ts': exempt('confirmation of a category by its handle'),
	'api/v1/verify/categories/[handle]/+server.ts': exempt('confirmation of a category by its handle'),
	'api/v1/verify/categories/[handle]/holder/+server.ts': WRITES,
	'.well-known/receipt-keys.json/+server.ts': exempt('public keys of receipts'),

	// Writes: the matrix reads.
	'api/v1/companies/+server.ts': WRITES,
	'api/v1/companies/[company_id]/api-keys/[key_id]/+server.ts': WRITES,
	'api/v1/companies/[company_id]/members/[member_id]/+server.ts': WRITES,
	'api/v1/companies/[company_id]/verification/+server.ts': WRITES,
	'api/v1/hiring/[process_id]/reports/+server.ts': WRITES,
	'api/v1/integrations/fsp/webhooks/+server.ts': WRITES,
	'api/v1/integrations/telegram/webhook/+server.ts': WRITES,
	'api/v1/invitations/[invitation_id]/messages/read/+server.ts': WRITES,
	'api/v1/invitations/[invitation_id]/response/+server.ts': WRITES,
	'api/v1/invitations/[invitation_id]/terms/+server.ts': WRITES,
	'api/v1/invitations/[invitation_id]/viewed/+server.ts': WRITES,
	'api/v1/invitations/[invitation_id]/withdrawal/+server.ts': WRITES,
	'api/v1/me/objections/[objection_id]/withdrawal/+server.ts': WRITES,
	'api/v1/me/tests/decisions/[decision_id]/objections/+server.ts': WRITES,
	'api/v1/me/grade-declarations/+server.ts': WRITES,
	'api/v1/me/surveys/+server.ts': WRITES,
	'api/v1/me/profile/experience/+server.ts': WRITES,
	'api/v1/me/profile/experience/[entry_id]/+server.ts': WRITES,
	'api/v1/me/profile/suggestions/[suggestion_id]/decision/+server.ts': WRITES,
	'api/v1/me/company-blocks/[company_id]/+server.ts': WRITES,
	'api/v1/operator/ages/[candidate_id]/decision/+server.ts': WRITES,
	'api/v1/operator/assessments/attempts/[attempt_id]/annulment/+server.ts': WRITES,
	'api/v1/me/tests/+server.ts': WRITES,
	'api/v1/me/tests/[attempt_id]/items/[seq]/answer/+server.ts': WRITES,
	'api/v1/operator/moderation/vacancies/[vacancy_id]/decision/+server.ts': WRITES,
	'api/v1/operator/objections/[objection_id]/assign/+server.ts': WRITES,
	'api/v1/operator/objections/[objection_id]/resolution/+server.ts': WRITES,
	'api/v1/vacancies/[vacancy_id]/close/+server.ts': WRITES,
	'api/v1/vacancies/[vacancy_id]/pause/+server.ts': WRITES,
	'api/v1/vacancies/[vacancy_id]/publish/+server.ts': WRITES,
	'api/v1/vacancies/[vacancy_id]/resume/+server.ts': WRITES,
	'api/v1/vacancies/drafts/from-text/+server.ts': WRITES,

	// Requests of a confirmation, calls and applications (domain 13.11, 13.12, 13.5). The rows are the company's own or
	// the candidate's own; a request and a delivery are made only to a candidate `canShow` lets the company see, so a
	// session never reaches across — the services check the reach again on every read (confirmation-requests.test.ts,
	// challenges.test.ts, applications.test.ts).
	'(app)/me/vacancies/[id]/+page.server.ts': target(
		'candidate',
		'scope',
		(_, t) => `/me/vacancies/${t.vacancyId}`,
		(_, t) => ({ id: t.vacancyId })
	),
	'(app)/me/challenges/+page.server.ts': exempt('deliveries of the own profile — challenges.test.ts'),
	'(app)/me/challenges/[deliveryId]/+page.server.ts': exempt('a delivery of the own profile — challenges.test.ts'),
	'(app)/me/confirmations/+page.server.ts': exempt('requests to the own profile — confirmation-requests.test.ts'),
	'(app)/me/applications/+page.server.ts': exempt('the own applications — applications.test.ts'),
	'(app)/company/(member)/challenges/+page.server.ts': exempt('calls of the own company — challenges.test.ts'),
	'(app)/company/(member)/challenges/[id]/+page.server.ts': exempt(
		'a call of the own company, its solutions through canShow — challenges.test.ts'
	),
	'(app)/company/(member)/applications/+page.server.ts': exempt(
		'applications to the own company — applications.test.ts'
	),
	'(app)/company/(member)/applications/[id]/+page.server.ts': exempt(
		'an application to the own company — applications.test.ts'
	),
	'(app)/company/(member)/confirmations/+page.server.ts': exempt(
		'requests of the own company — confirmation-requests.test.ts'
	),
	'api/v1/confirmation-requests/+server.ts': exempt('requests of the own company — confirmation-requests.test.ts'),
	'api/v1/me/confirmation-requests/+server.ts': exempt('requests to the own profile — confirmation-requests.test.ts'),
	'api/v1/me/confirmation-requests/[request_id]/accept/+server.ts': WRITES,
	'api/v1/me/confirmation-requests/[request_id]/decline/+server.ts': WRITES,
	'api/v1/me/block-confirmations/[confirmation_id]/visibility/+server.ts': WRITES,
	'api/v1/challenges/+server.ts': exempt('calls of the own company — challenges.test.ts'),
	'api/v1/challenges/[challenge_id]/+server.ts': exempt('a call of the own company — challenges.test.ts'),
	'api/v1/challenges/[challenge_id]/solutions/+server.ts': exempt(
		'solutions of a call of the own company through canShow — challenges.test.ts'
	),
	'api/v1/challenges/[challenge_id]/solutions/[solution_id]/dismissal/+server.ts': WRITES,
	'api/v1/me/challenges/+server.ts': exempt('deliveries of the own profile — challenges.test.ts'),
	'api/v1/me/challenges/[delivery_id]/viewed/+server.ts': WRITES,
	'api/v1/me/challenges/[delivery_id]/solutions/+server.ts': WRITES,
	'api/v1/me/challenges/[delivery_id]/solutions/[solution_id]/+server.ts': WRITES,
	'api/v1/me/challenges/[delivery_id]/dismissal/+server.ts': WRITES,
	'api/v1/demo/clock/+server.ts': WRITES,
	'api/v1/me/applications/+server.ts': exempt('the own applications — applications.test.ts'),
	'api/v1/me/applications/[application_id]/withdrawal/+server.ts': WRITES,
	'api/v1/me/consents/[kind]/+server.ts': WRITES,
	'api/v1/me/consents/[kind]/revocation/+server.ts': WRITES,
	'api/v1/me/resumes/[resume_id]/+server.ts': WRITES,
	'api/v1/me/resumes/claims/[claim_id]/review/+server.ts': WRITES,
	'api/v1/me/resumes/experience/[entry_id]/+server.ts': WRITES,
	'api/v1/me/resumes/experience/[entry_id]/review/+server.ts': WRITES,
	'api/v1/applications/+server.ts': exempt('applications to the own company — applications.test.ts'),
	'api/v1/applications/[application_id]/+server.ts': exempt('an application to the own company — applications.test.ts'),
	'api/v1/applications/[application_id]/rejection/+server.ts': WRITES,
	'api/v1/me/demand/+server.ts': exempt('an aggregate of the needs within reach — need-demand.test.ts')
};

// --- The matrix ------------------------------------------------------------------------------------------------------

const hasAny = (text: string, markers: readonly string[]) => markers.filter((marker) => text.includes(marker));

describe('the registry of routes', () => {
	it('names every route of the application, and no route that is gone', () => {
		expect(Object.keys(REGISTRY).sort()).toEqual(Object.keys(ROUTE_MODULES).sort());
	});

	it('exempts as writing only the routes that neither load nor answer GET', async () => {
		for (const [route, entry] of Object.entries(REGISTRY)) {
			if (entry.kind !== 'exempt' || entry.reason !== 'writes') continue;
			const importer = ROUTE_MODULES[route];
			if (!importer) continue;
			const module = await importer();
			expect(module.load === undefined && module.GET === undefined, route).toBe(true);
		}
	});
});

describe('isolation of demo sessions in every reading route', () => {
	const cases = Object.entries(REGISTRY).filter(
		(entry): entry is [string, ListCase | TargetCase] => entry[1].kind !== 'exempt'
	);

	it.each(cases)('%s', async (route, entry) => {
		for (const viewerKey of VIEWERS) {
			const viewer = places[viewerKey];
			const seen = SEES[entry.rule][viewerKey];
			const userId = USERS[entry.role](viewer);
			if (entry.kind === 'list') {
				const answer = await runRoute(route, userId, entry.path(viewer), entry.params?.(viewer) ?? {});
				expect(answer.ok, `${route} for ${viewerKey}: ${answer.status} ${answer.text.slice(0, 300)}`).toBe(true);
				for (const key of PLACES) {
					const found = hasAny(answer.text, markersOf(places[key], viewer));
					if (seen.includes(key)) expect(found.length, `${route}: ${viewerKey} sees ${key}`).toBeGreaterThan(0);
					else expect(found, `${route}: ${viewerKey} must not see ${key}`).toEqual([]);
				}
				continue;
			}
			for (const key of PLACES) {
				const shown = places[key];
				const answer = await runRoute(route, userId, entry.path(viewer, shown), entry.params(viewer, shown));
				const found = hasAny(answer.text, markersOf(shown, viewer));
				if (seen.includes(key)) {
					expect(answer.ok, `${route}: ${viewerKey} opens ${key}: ${answer.status} ${answer.text.slice(0, 300)}`).toBe(
						true
					);
					expect(found.length, `${route}: ${viewerKey} sees ${key}`).toBeGreaterThan(0);
				} else {
					expect(found, `${route}: ${viewerKey} must not see ${key} (${answer.status})`).toEqual([]);
				}
				for (const other of PLACES.filter((k) => k !== key && !seen.includes(k))) {
					expect(
						hasAny(answer.text, markersOf(places[other], viewer)),
						`${route}: ${viewerKey} leaks ${other}`
					).toEqual([]);
				}
			}
		}
	});
});
