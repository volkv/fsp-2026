// Minimal valid rows for tests. Each factory inserts one row with sensible defaults; `overrides` replace columns.
import { randomBytes } from 'node:crypto';
import { and, desc, eq, type InferInsertModel, type Table } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import {
	candidates,
	companies,
	consentEvents,
	companyMembers,
	legalDocuments,
	pdOperators,
	productPolicies,
	taxonomyVersions,
	users,
	vacancies
} from '$lib/server/db/schema';
import type { OfferInput } from '$lib/server/invitations/send';
import type { TextCheck } from '$lib/server/vacancies/text-check';
import { ageBand } from '$lib/server/visibility/age';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = () => hex(32);

type Insert<T extends Table> = Partial<InferInsertModel<T>>;

export async function createUser(db: Executor, overrides: Insert<typeof users> = {}) {
	const [row] = await db
		.insert(users)
		.values({ status: 'active', emailEnc: randomBytes(40), emailHmac: hex(32), ...overrides })
		.returning();
	if (!row) throw new Error('user not inserted');
	return row;
}

/**
 * An active adult candidate has signed `pd_processing` a day ago, as the registration leaves them: without it nothing of
 * theirs is processed. `processingConsent: false` leaves the consent out for the tests of consent itself; a minor, a
 * candidate of unknown age or one not active gets none.
 */
export async function createCandidate(
	db: Executor,
	overrides: Insert<typeof candidates> = {},
	options: { processingConsent?: boolean } = {}
) {
	const userId = overrides.userId ?? (await createUser(db)).id;
	const [row] = await db
		.insert(candidates)
		.values({
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: '1998-05-10',
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified',
			...overrides,
			userId
		})
		.returning();
	if (!row) throw new Error('candidate not inserted');
	const birth = { birthDate: row.birthDate, precision: row.birthDatePrecision, status: row.birthDateStatus };
	// Signed long ago once adult, so that a test on a fixed clock finds it in effect too; an adult of the last year signed
	// yesterday.
	const yesterday = new Date(Date.now() - 86_400_000);
	const early = row.birthDate === null ? yesterday : new Date(Date.UTC(Number(row.birthDate.slice(0, 4)) + 19, 0, 1));
	const signedAt = early < yesterday ? early : yesterday;
	if ((options.processingConsent ?? true) && row.status === 'active' && ageBand(birth, signedAt) === 'adult') {
		await db.insert(consentEvents).values({
			subjectCandidateId: row.id,
			kind: 'pd_processing',
			documentId: await processingDocument(db),
			action: 'grant',
			signerKind: 'subject',
			signerUserId: userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: signedAt
		});
	}
	return row;
}

/**
 * The `pd_processing` text the default consent of `createCandidate` refers to: published long ago and superseded, so it
 * is never the current document of a test that publishes its own, while consents to it stay in effect.
 */
async function processingDocument(db: Executor): Promise<string> {
	const [draft] = await db
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(and(eq(legalDocuments.kind, 'pd_processing'), eq(legalDocuments.title, DEFAULT_CONSENT_TITLE)))
		.limit(1);
	if (draft) return draft.id;
	// Numbered after whatever the database holds: a seeded stand has its own versions.
	const [latest] = await db
		.select({ version: legalDocuments.version })
		.from(legalDocuments)
		.where(eq(legalDocuments.kind, 'pd_processing'))
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	const published = await createPublishedDocument(db, 'pd_processing', {
		version: (latest?.version ?? 0) + 1,
		title: DEFAULT_CONSENT_TITLE,
		publishedAt: new Date('2000-01-01T00:00:00Z'),
		supersededAt: new Date('2000-01-02T00:00:00Z')
	});
	return published.id;
}

const DEFAULT_CONSENT_TITLE = 'pd_processing (default consent of test candidates)';

/** A valid INN: 10 digits; the checksum is not verified by the database. */
const inn = () => String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10);

export async function createCompany(db: Executor, overrides: Insert<typeof companies> = {}) {
	const status = overrides.status ?? 'verified';
	const [row] = await db
		.insert(companies)
		.values({
			inn: inn(),
			legalName: 'ООО «Пример»',
			displayName: 'Пример',
			// The profile an offer needs (domain 5.1, 13.5); a test of the incomplete profile clears it.
			description: 'Разрабатываем сервисы для логистики и платежей, команда из сорока инженеров.',
			activity: 'Разработка программного обеспечения',
			status,
			verifiedAt: status === 'verified' || status === 'suspended' ? new Date() : null,
			...overrides
		})
		.returning();
	if (!row) throw new Error('company not inserted');
	return row;
}

export async function createMember(db: Executor, companyId: string, overrides: Insert<typeof companyMembers> = {}) {
	const userId = overrides.userId ?? (await createUser(db)).id;
	const [row] = await db
		.insert(companyMembers)
		.values({ companyId, role: 'owner', status: 'active', joinedAt: new Date(), ...overrides, userId })
		.returning();
	if (!row) throw new Error('member not inserted');
	return row;
}

export async function createTaxonomyVersion(db: Executor, overrides: Insert<typeof taxonomyVersions> = {}) {
	const [row] = await db
		.insert(taxonomyVersions)
		.values({ label: `test-${hex(4)}`, status: 'draft', sources: {}, ...overrides })
		.returning();
	if (!row) throw new Error('taxonomy version not inserted');
	return row;
}

/** A clean check of the text as the application stores it: the vacancy reads back through `textCheckSchema`. */
const textCheck: TextCheck = {
	validator_version: 'test',
	result: 'clean',
	phrases: [],
	warnings_confirmed: null,
	moderation: null
};

export async function createOwnVacancy(
	db: Executor,
	input: { companyId: string; memberId: string; taxonomyVersionId: string },
	overrides: Insert<typeof vacancies> = {}
) {
	const [row] = await db
		.insert(vacancies)
		.values({
			companyId: input.companyId,
			createdByMemberId: input.memberId,
			taxonomyVersionId: input.taxonomyVersionId,
			title: 'Backend-разработчик на Go',
			description: 'Разработка сервисов',
			roleKey: 'backend',
			gradeMin: 'middle',
			gradeMax: 'senior',
			requiredSkillKeys: ['go'],
			workFormat: 'remote',
			employmentForm: 'full_time',
			contractTypes: ['employment'],
			salaryMin: 250_000,
			salaryMax: 350_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			textCheck,
			status: 'published',
			publishedAt: new Date(),
			...overrides
		})
		.returning();
	if (!row) throw new Error('vacancy not inserted');
	return row;
}

export async function createPolicy(db: Executor, kind: 'invitation_policy' | 'hiring_policy', version = 1) {
	const params =
		kind === 'invitation_policy'
			? {
					response_window_hours: 72,
					decline_reason_codes: ['salary', 'other'],
					reason_required: true,
					max_open_per_company_per_day: 50,
					reopen_cooldown_days: 14,
					max_reopens: 2
				}
			: {
					outcome_due_days: 30,
					reminder_intervals_days: [7],
					max_reminders: 2,
					stages: ['interview_scheduled'],
					outcome_reason_codes: ['other']
				};
	const [row] = await db
		.insert(productPolicies)
		.values({ kind, version, params, effectiveFrom: new Date() })
		.returning();
	if (!row) throw new Error('policy not inserted');
	return row;
}

let documentVersion = 0;

export async function createPublishedDocument(
	db: Executor,
	kind: (typeof legalDocuments.$inferInsert)['kind'],
	overrides: Insert<typeof legalDocuments> = {}
) {
	const [operator] = await db
		.insert(pdOperators)
		.values({
			legalName: 'Оператор',
			inn: '7700000000',
			ogrn: '1027700000000',
			address: 'Москва',
			contactEmail: 'pd@example.org',
			validFrom: '2026-01-01'
		})
		.returning();
	if (!operator) throw new Error('operator not inserted');
	const [row] = await db
		.insert(legalDocuments)
		.values({
			kind,
			version: ++documentVersion,
			title: kind,
			body: `Текст документа ${kind}`,
			bodySha256: sha256(),
			pdOperatorId: operator.id,
			operatorSnapshot: {},
			processorsSnapshot: [],
			purposes: ['profile'],
			dataCategories: ['profile'],
			operations: ['store'],
			form: 'electronic_separate_screen',
			available: true,
			requiresReconsent: false,
			publishedAt: new Date(),
			...overrides
		})
		.returning();
	if (!row) throw new Error('document not inserted');
	return row;
}

export { sha256 as randomSha256 };

/**
 * The terms of an offer as the employer writes them (domain 13.5): a description, a range in roubles per month, the work
 * format, the company's contact and one point of «why you» with its source. `overrides` replace fields.
 */
export function offerTerms(overrides: Partial<OfferInput> = {}): OfferInput {
	return {
		title: 'Backend-разработчик на Go',
		description: 'Развиваем платёжный шлюз: Go, PostgreSQL, Kafka. Команда из шести инженеров, релизы каждую неделю.',
		salaryMin: 260_000,
		salaryMax: 300_000,
		salaryCurrency: 'RUB',
		salaryTaxBase: 'gross',
		workFormat: 'remote',
		contactMethod: { kind: 'email', value: 'hr@example.ru' },
		whyYou: [
			{ text: 'Удалённый формат совпадает с предпочтениями', source: { kind: 'preference', ref: 'work_formats' } }
		],
		message: null,
		...overrides
	};
}

/**
 * The columns of an offer version a test inserts directly (domain 13.5), without a vacancy: the title, the description,
 * the work format, the contact, «why you» and a clean text check. The range and the dates are the test's.
 */
export function offerTermsRow() {
	return {
		title: 'Backend-разработчик на Go',
		description: 'Развиваем платёжный шлюз: Go, PostgreSQL, Kafka. Команда из шести инженеров, релизы каждую неделю.',
		workFormat: 'remote',
		contactMethod: { kind: 'email', value: 'hr@example.ru', note: null },
		whyYou: [
			{ text: 'Удалённый формат совпадает с предпочтениями', source: { kind: 'preference', ref: 'work_formats' } }
		],
		textCheck
	};
}
