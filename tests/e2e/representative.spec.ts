// The legal representative of a candidate aged 16 without an account, in the browser against the local infrastructure
// (`make infra`): the operator verifies the authority in the cabinet, the representative signs the consents by the link
// of the letter read from Mailpit, the candidate sees them in the profile and shows it for internships; an invitation
// to an internship open to minors is accepted by the candidate and waits for the representative, who consents to the
// disclosure by the link of another letter, and the invitation is accepted; the company sees the acceptance wait for the
// representative meanwhile. At the end the representative revokes the catalog consent by the link of the letter that
// followed the signature, after the page showed what the revocation does, and the candidate is told. The pages have no
// accessibility violations.
//
// The candidate, the operator role, the representative who confirmed the address and the company with the offer on
// the work of minors are written directly: they are state these screens receive from the registration, the
// administrator's grant and the employer's cabinet.
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { hashPassword } from '$lib/server/auth/password';
import { loadAccessSubject } from '$lib/server/companies/subject';
import type { Database } from '$lib/server/db';
import {
	candidates,
	consentEvents,
	documentAcceptances,
	legalDocuments,
	legalRepresentatives,
	passwordCredentials,
	representations,
	staffRoles,
	taxonomyVersions,
	users
} from '$lib/server/db/schema';
import { createCompany, createMember, createOwnVacancy, offerTerms } from '../helpers/factories';

// `$env/dynamic/private`, which these modules need through `$lib/server/config`, only SvelteKit provides; the hook that
// resolves it for a plain Node test process is registered process-wide (`playwright.config.ts`).
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { closeDb, db } = await import('$lib/server/db');
const { invitationDeps } = await import('$lib/server/invitations/deps');
const { createInvitation } = await import('$lib/server/invitations/send');

/** Mailpit's API on the host (compose.yaml publishes 8025 as 57825). */
const MAILPIT = 'http://127.0.0.1:57825';
const PASSWORD = 'e2e passphrase long';

// Forms are posted to the public origin of the application (helpers/ports.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

test.afterAll(async () => {
	await closeDb();
});

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

/** The path and query of the link of the newest letter to the address whose subject contains `subject`. */
async function linkFromLetter(to: string, subject: string): Promise<string> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
		const { messages } = (await search.json()) as { messages: { ID: string; Subject: string }[] };
		const letter = messages.find((m) => m.Subject.includes(subject));
		if (letter) {
			const { Text } = (await (await fetch(`${MAILPIT}/api/v1/message/${letter.ID}`)).json()) as { Text: string };
			const link = /https?:\/\/\S+token=[A-Za-z0-9_%-]+/.exec(Text)?.[0];
			if (!link) throw new Error(`letter «${letter.Subject}» has no link`);
			const url = new URL(link);
			return `${url.pathname}${url.search}`;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`no letter «${subject}» to ${to}`);
}

async function currentDocumentId(
	database: Database,
	kind: 'pd_processing' | 'minor_employment_terms'
): Promise<string> {
	const [document] = await database
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(and(eq(legalDocuments.kind, kind), lte(legalDocuments.publishedAt, new Date())))
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!document) throw new Error(`no published ${kind} document: run scripts/seed-legal.ts`);
	return document.id;
}

async function personWithPassword(database: Database, email: string, name: string): Promise<string> {
	const crypto = fieldCrypto();
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName: name
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	await database
		.insert(passwordCredentials)
		.values({ userId: user.id, hash: await hashPassword(PASSWORD), changedAt: now });
	return user.id;
}

function birthDateAged(years: number): string {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	date.setUTCDate(date.getUTCDate() - 30);
	return date.toISOString().slice(0, 10);
}

/**
 * A candidate aged 16 who signed the processing consent and named a representative who confirmed the address: the
 * state the operator's queue receives from the registration.
 */
async function seedTeenager() {
	const database = db();
	const crypto = fieldCrypto();
	const email = `e2e-teen-${randomUUID()}@example.org`;
	const representativeEmail = `e2e-parent-${randomUUID()}@example.org`;
	const userId = await personWithPassword(database, email, 'Алиса Тестова');
	const [candidate] = await database
		.insert(candidates)
		.values({
			userId,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: birthDateAged(16),
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified',
			lastNameEnc: crypto.encrypt('Тестова', 'candidates.last_name'),
			firstNameEnc: crypto.encrypt('Алиса', 'candidates.first_name')
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	await database.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: await currentDocumentId(database, 'pd_processing'),
		action: 'grant',
		signerKind: 'subject',
		signerUserId: userId,
		method: 'separate_screen_button',
		evidence: { source: 'e2e' },
		occurredAt: new Date(Date.now() - 3_600_000)
	});
	const [representative] = await database
		.insert(legalRepresentatives)
		.values({
			fullNameEnc: crypto.encrypt('Тестова Елена Викторовна', 'legal_representatives.full_name'),
			emailEnc: crypto.encrypt(representativeEmail, 'legal_representatives.email'),
			emailHmac: crypto.lookupHmac('email', representativeEmail)
		})
		.returning();
	if (!representative) throw new Error('representative not inserted');
	const now = new Date();
	const [representation] = await database
		.insert(representations)
		.values({
			candidateId: candidate.id,
			representativeId: representative.id,
			relation: 'parent',
			status: 'contact_confirmed',
			invitedAt: now,
			contactConfirmedAt: now
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	return { email, representativeEmail, candidateId: candidate.id, representationId: representation.id };
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/login');
}

/** A person of the federation with the operator role, as the administrator's grant stores it, signed in. */
async function signInOperator(browser: Browser): Promise<Page> {
	const email = `e2e-staff-${randomUUID()}@example.org`;
	const userId = await personWithPassword(db(), email, 'Оператор Проверочный');
	await db().insert(staffRoles).values({ userId, role: 'operator', grantedAt: new Date() });
	const page = await (await browser.newContext({ baseURL: APP_ORIGIN })).newPage();
	await signIn(page, email);
	return page;
}

/**
 * A verified company that accepted the offer on the work of minors invites the candidate to its internship; its member
 * signs in with the address returned.
 */
async function seedInternshipInvitation(candidateId: string): Promise<{ invitationId: string; memberEmail: string }> {
	const database = db();
	const [taxonomy] = await database
		.select({ id: taxonomyVersions.id })
		.from(taxonomyVersions)
		.where(isNotNull(taxonomyVersions.publishedAt))
		.orderBy(desc(taxonomyVersions.publishedAt))
		.limit(1);
	if (!taxonomy) throw new Error('no published taxonomy');
	const company = await createCompany(database, { displayName: `Е2Е Стажировки ${randomUUID().slice(0, 6)}` });
	const memberEmail = `e2e-recruiter-${randomUUID()}@example.org`;
	const member = await createMember(database, company.id, {
		userId: await personWithPassword(database, memberEmail, 'Рекрутер Стажировок')
	});
	if (member.userId === null) throw new Error('an active member has a user');
	const [acceptance] = await database
		.insert(documentAcceptances)
		.values({
			documentId: await currentDocumentId(database, 'minor_employment_terms'),
			userId: member.userId,
			companyId: company.id,
			acceptedAt: new Date()
		})
		.returning();
	if (!acceptance) throw new Error('acceptance not inserted');
	const vacancy = await createOwnVacancy(
		database,
		{ companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.id },
		{
			title: 'Стажёр-фронтендер',
			// A text check as the cabinet stores it: the vacancy list of the company reads it back.
			textCheck: {
				validator_version: 'e2e',
				phrases: [],
				result: 'clean',
				warnings_confirmed: null,
				moderation: null
			},
			minAge: 14,
			minorTermsAcceptanceId: acceptance.id,
			salaryMin: 40_000,
			salaryMax: 60_000
		}
	);
	const subject = await loadAccessSubject(database, {
		kind: 'session',
		userId: member.userId,
		sessionHash: 'e2e',
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: 'e2e'
	});
	const sent = await createInvitation(
		invitationDeps(),
		subject,
		{ requestId: `e2e-${randomUUID()}` },
		{
			...offerTerms({
				title: 'Стажёр-фронтендер',
				vacancyId: vacancy.id,
				salaryMin: 45_000,
				salaryMax: 55_000,
				message: 'Приглашаем на летнюю стажировку.'
			}),
			candidateId
		}
	);
	return { invitationId: sent.invitationId, memberEmail };
}

test('the representative signs the consents and the disclosure by the links of letters', async ({ page, browser }) => {
	const teen = await seedTeenager();

	// The operator verifies the authority: the representative gets the letter with the consents.
	const operator = await signInOperator(browser);
	await operator.goto(`/operator/representatives/${teen.representationId}`);
	await operator.getByLabel('Минимальное основание').selectOption('birth_certificate');
	await operator.getByRole('button', { name: 'Подтвердить полномочия' }).click();
	await expect(operator).toHaveURL(/decided=verified/);

	// The representative, without an account, signs by the link of the letter.
	const representative = await (await browser.newContext({ baseURL: APP_ORIGIN })).newPage();
	await representative.goto(await linkFromLetter(teen.representativeEmail, 'Согласие законного представителя'));
	const consents = representative.getByTestId('representative-consents');
	await expect(consents.locator('[data-consent]')).toHaveCount(3);
	await expectNoAxeViolations(representative);
	await consents.locator('[data-consent="pd_processing"]').getByRole('checkbox', { name: 'Даю согласие' }).check();
	await consents.locator('[data-consent="catalog_visibility"]').getByRole('checkbox', { name: 'Даю согласие' }).check();
	await representative.getByRole('button', { name: 'Подписать отмеченные согласия' }).click();
	await expect(representative.getByText('Согласия подписаны.')).toBeVisible();

	// The candidate sees it in the profile and shows the profile for internships.
	await signIn(page, teen.email);
	await page.goto('/me/profile');
	await expect(page.getByTestId('consent-state')).toHaveAttribute('data-state', 'representative_received');
	await page.goto('/me/consents');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Согласия');
	const signed = page.getByTestId('representative-consents');
	await expect(signed.locator('[data-consent="pd_processing"]')).toHaveAttribute('data-representative', 'true');
	await expect(signed.locator('[data-consent="catalog_visibility"]')).toHaveAttribute('data-representative', 'true');
	await expect(signed.locator('[data-consent="fsp_import"]')).toHaveAttribute('data-representative', 'false');
	await expectNoAxeViolations(page);
	await page.goto('/me/visibility');
	await page.getByRole('button', { name: 'Даю согласие и показываю профиль' }).click();
	await expect(page.getByTestId('visibility-state')).toContainText('стажировк');

	// The candidate accepts the internship: the acceptance waits for the representative.
	const { invitationId, memberEmail } = await seedInternshipInvitation(teen.candidateId);
	await page.goto(`/me/invitations/${invitationId}`);
	await page.getByTestId('invitation-answer').getByRole('button', { name: 'Принять и раскрыть выбранное' }).click();
	await expect(page.getByText('Законному представителю ушло письмо')).toBeVisible();
	await expect(page.getByTestId('awaiting-representative')).toContainText('ФИО, Почта');
	await expectNoAxeViolations(page);

	// The company sees that the acceptance waits for the representative, without the fields the candidate chose.
	const recruiter = await (await browser.newContext({ baseURL: APP_ORIGIN })).newPage();
	await signIn(recruiter, memberEmail);
	await recruiter.goto('/company/invitations');
	await expect(recruiter.locator(`[data-invitation="${invitationId}"]`)).toContainText(
		'Принято, ждём согласия представителя'
	);
	await expectNoAxeViolations(recruiter);
	await recruiter.goto(`/company/invitations/${invitationId}`);
	const waiting = recruiter.getByTestId('awaiting-representative');
	await expect(waiting).toContainText('ждём согласия законного представителя');
	await expect(waiting).not.toContainText('ФИО');
	await expect(recruiter.getByTestId('contacts')).toHaveCount(0);
	await expectNoAxeViolations(recruiter);

	// The representative consents to the disclosure of this invitation.
	const disclosureLink = await linkFromLetter(teen.representativeEmail, 'Согласие на раскрытие контактов');
	await representative.goto(disclosureLink);
	await expect(representative.getByTestId('representative-disclosure')).toContainText('Стажёр-фронтендер');
	await expectNoAxeViolations(representative);
	await representative.getByRole('button', { name: 'Согласен на раскрытие' }).click();
	await expect(representative.getByText('Согласие дано: приглашение принято')).toBeVisible();

	// The invitation is accepted: the company received the name and the address.
	await page.goto(`/me/invitations/${invitationId}`);
	await expect(page.getByTestId('disclosure')).toContainText('ФИО, Почта');
	await expect(page.getByTestId('awaiting-representative')).toHaveCount(0);
	await recruiter.goto(`/company/invitations/${invitationId}`);
	await expect(recruiter.getByTestId('awaiting-representative')).toHaveCount(0);
	await expect(recruiter.getByTestId('contacts')).toBeVisible();

	// The link worked once.
	await representative.goto(disclosureLink);
	await expect(representative.getByText('Ссылка недействительна')).toBeVisible();

	// The letter that followed the signature leads back to the consents: the representative revokes the catalog one.
	const manageLink = await linkFromLetter(teen.representativeEmail, 'Согласия законного представителя изменены');
	await representative.goto(manageLink);
	const manage = representative.getByTestId('representative-consents');
	await expect(manage.locator('[data-consent="catalog_visibility"]')).toHaveAttribute('data-signed', 'true');
	await manage.locator('[data-consent="catalog_visibility"]').getByRole('checkbox', { name: 'Отозвать' }).check();
	await representative.getByRole('button', { name: 'Отозвать отмеченные…' }).click();
	const confirmation = representative.getByTestId('revoke-confirmation');
	await expect(confirmation.locator('[data-consequence="catalog_visibility"]')).toContainText(
		'перестанет показываться работодателям'
	);
	await expectNoAxeViolations(representative);
	await confirmation.getByRole('button', { name: 'Отозвать согласие' }).click();
	await expect(representative.getByText('Согласие отозвано: на показ профиля работодателям.')).toBeVisible();
	await representative.goto(manageLink);
	await expect(representative.getByText('Ссылка недействительна')).toBeVisible();

	// The candidate is told and sees the representative's side of the catalog consent gone.
	await page.goto('/notifications');
	await page.getByRole('link', { name: 'Законный представитель отозвал согласия' }).first().click();
	await expect(page).toHaveURL(/\/me\/consents$/u);
	await expect(
		page.getByTestId('representative-consents').locator('[data-consent="catalog_visibility"]')
	).toHaveAttribute('data-representative', 'false');

	// A new letter by the representative's own request.
	await representative.goto('/representative/letter');
	await expectNoAxeViolations(representative);
	await representative.getByLabel('Почта представителя').fill(teen.representativeEmail);
	await representative.getByRole('button', { name: 'Прислать письмо' }).click();
	await expect(representative.getByText('письмо уже в пути')).toBeVisible();
});
