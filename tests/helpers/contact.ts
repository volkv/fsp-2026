// The world of the tests of contact (requests of a confirmation, calls of companies, applications): the published
// taxonomy with its rule sets, the product policies, the texts of the consents, released fixture banks, and the people —
// a member of a company and candidates in the catalog with a category confirmed by a test.
import { fileURLToPath } from 'node:url';
import { desc } from 'drizzle-orm';
import postgres from 'postgres';
import type { AccessSubject } from '$lib/server/access/permissions';
import { gradeDefinition, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { createFieldCrypto, type FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import { consentEvents, productPolicies, taxonomyVersions } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { releaseFixtureBank, type FixtureBank } from './bank';
import { decide } from './categories';
import type { TestDatabase } from './database';
import { createCandidate, createCompany, createMember, createPublishedDocument, createUser } from './factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
export const DAY = 86_400_000;

export interface ContactWorld {
	taxonomyVersionId: string;
	catalogDocumentId: string;
	disclosureDocumentId: string;
	banks: Map<SpecializationKey, FixtureBank>;
}

/** The field crypto of the tests: pseudonyms of companies and the contacts a disclosure opens. */
export const testCrypto: FieldCrypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

export async function contactWorld(
	database: TestDatabase,
	specializations: readonly SpecializationKey[]
): Promise<ContactWorld> {
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const effectiveFrom = new Date(Date.now() - 30 * DAY);
	await database.db.insert(productPolicies).values([
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom },
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
		{ kind: 'notification_policy', version: 1, params: { response_due_reminder_hours: [24] }, effectiveFrom },
		{
			kind: 'challenge_policy',
			version: 1,
			params: { period_hours: 24, candidate_interval_days: 7, per_run_per_challenge: 50 },
			effectiveFrom
		},
		{ kind: 'matching_policy', version: 1, params: { store_threshold: 0.3 }, effectiveFrom },
		{ kind: 'assessment_policy', version: 1, params: { artifact_retention_days: 365 }, effectiveFrom }
	]);
	const banks = new Map<SpecializationKey, FixtureBank>();
	for (const specialization of specializations) {
		banks.set(specialization, await releaseFixtureBank(database.db, specialization));
	}
	const catalogDocumentId = (
		await createPublishedDocument(database.db, 'catalog_visibility', { publishedAt: effectiveFrom })
	).id;
	const disclosureDocumentId = (
		await createPublishedDocument(database.db, 'contact_disclosure', { publishedAt: effectiveFrom })
	).id;
	const [version] = await database.db
		.select({ id: taxonomyVersions.id })
		.from(taxonomyVersions)
		.orderBy(desc(taxonomyVersions.publishedAt))
		.limit(1);
	if (!version) throw new Error('the taxonomy release was not published');
	return { taxonomyVersionId: version.id, catalogDocumentId, disclosureDocumentId, banks };
}

export function memberSubject(input: {
	userId: string;
	memberId: string;
	companyId: string;
	companyStatus?: 'verified' | 'draft' | 'suspended';
}): AccessSubject {
	return {
		userId: input.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: input.memberId,
			companyId: input.companyId,
			role: 'recruiter',
			status: 'active',
			companyStatus: input.companyStatus ?? 'verified'
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

export function candidateSubject(candidate: { id: string; userId: string }): AccessSubject {
	return {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

/** A company with its filled-in profile and an active member, as the member acts for it. */
export async function employer(db: Executor, overrides: { demoSessionId?: string } = {}) {
	const company = await createCompany(db, {
		status: 'verified',
		...(overrides.demoSessionId ? { demoSessionId: overrides.demoSessionId } : {})
	});
	const member = await createMember(
		db,
		company.id,
		overrides.demoSessionId ? { userId: (await sessionUser(db, overrides.demoSessionId)).id } : {}
	);
	if (!member.userId) throw new Error('member without user');
	return {
		company,
		member,
		subject: memberSubject({ userId: member.userId, memberId: member.id, companyId: company.id })
	};
}

const sessionUser = (db: Executor, demoSessionId: string) => createUser(db, { demoSessionId });

export interface PersonSetup {
	category?: { specialization: SpecializationKey; grade: GradeKey };
	visibility?: 'catalog' | 'hidden';
	birthDate?: string;
	demoSessionId?: string;
}

/** A candidate in the catalog (`catalog_visibility` in effect) with a category confirmed by a test, if asked. */
export async function person(db: TestDatabase['db'], world: ContactWorld, setup: PersonSetup = {}) {
	const user = setup.demoSessionId ? await sessionUser(db, setup.demoSessionId) : null;
	const row = await createCandidate(db, {
		visibility: setup.visibility ?? 'catalog',
		...(setup.birthDate ? { birthDate: setup.birthDate } : {}),
		...(user ? { userId: user.id, demoSessionId: setup.demoSessionId } : {})
	});
	await db.insert(consentEvents).values({
		subjectCandidateId: row.id,
		kind: 'catalog_visibility',
		documentId: world.catalogDocumentId,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: row.userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - 2 * DAY)
	});
	if (setup.category) {
		const [first, second] = gradeDefinition(setup.category.specialization, setup.category.grade).defining;
		if (!first || !second) throw new Error('a grade has two defining blocks');
		await decide(db, row.id, {
			...setup.category,
			decidedAt: new Date(Date.now() - 20 * DAY),
			blocks: [
				{ block: first, items: 4, score: 50, cut: 50 },
				{ block: second, items: 3, score: 40, cut: 40 }
			]
		});
	}
	return { ...row, subject: candidateSubject(row) };
}

/** The refusal an operation ends with; a success is a failure of the test. */
export async function refusal(operation: Promise<unknown>): Promise<ApiError> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('the operation was expected to be refused');
}

/** The code of `details[0]` of a refusal. */
export const detailCode = (error: ApiError): string | undefined => error.details?.[0]?.code;
