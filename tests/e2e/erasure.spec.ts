// Revocations, the export of own data and the deletion of the account in the browser against the local
// infrastructure (`make infra`, the legal documents of `scripts/seed-legal.ts`). A candidate revokes the import of FSP
// achievements on the page of consents and the achievement leaves the profile at once, downloads their data, then
// revokes the processing consent — which deletes the account: the session ends and the account waits for its purge. The
// last owner of a company is refused with the reason. The pages have no accessibility violations.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, desc, eq, lte } from 'drizzle-orm';
import {
	auditEvents,
	candidates,
	companyMembers,
	consentEvents,
	jobs,
	legalDocuments,
	passwordCredentials,
	sourceFacts,
	users
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth/password';
import { createCompany } from '../helpers/factories';

// `$env/dynamic/private`, which these modules need through `$lib/server/config`, only SvelteKit provides; the hook
// that resolves it for a plain Node test process is registered process-wide (`playwright.config.ts`).
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { closeDb, db } = await import('$lib/server/db');

const PASSWORD = 'e2e passphrase long';

// Forms are posted to the public origin of the application (playwright.config.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

test.afterAll(async () => {
	await closeDb();
});

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

async function currentDocumentId(database: Database, kind: 'pd_processing' | 'fsp_import'): Promise<string> {
	const [document] = await database
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(and(eq(legalDocuments.kind, kind), lte(legalDocuments.publishedAt, new Date())))
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!document) throw new Error(`no published ${kind} document: run scripts/seed-legal.ts`);
	return document.id;
}

/** An account with a password and a verified address. */
async function seedAccount(label: string, displayName: string) {
	const database = db();
	const crypto = fieldCrypto();
	const email = `e2e-${label}-${randomUUID()}@example.org`;
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	await database
		.insert(passwordCredentials)
		.values({ userId: user.id, hash: await hashPassword(PASSWORD), changedAt: now });
	return { email, userId: user.id };
}

/** An adult candidate with the processing consent and one FSP achievement imported under the import consent. */
async function seedCandidate() {
	const database = db();
	const account = await seedAccount('erasure', 'Вера Удаляева');
	const [candidate] = await database
		.insert(candidates)
		.values({
			userId: account.userId,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: '1996-03-14',
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified'
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	const signedAt = new Date(Date.now() - 3_600_000);
	await database.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: await currentDocumentId(database, 'pd_processing'),
		action: 'grant',
		signerKind: 'subject',
		signerUserId: account.userId,
		method: 'separate_screen_button',
		evidence: { source: 'e2e' },
		occurredAt: signedAt
	});
	const [grant] = await database
		.insert(consentEvents)
		.values({
			subjectCandidateId: candidate.id,
			kind: 'fsp_import',
			documentId: await currentDocumentId(database, 'fsp_import'),
			action: 'grant',
			signerKind: 'subject',
			signerUserId: account.userId,
			method: 'separate_screen_button',
			evidence: { source: 'e2e' },
			occurredAt: signedAt
		})
		.returning({ id: consentEvents.id });
	if (!grant) throw new Error('consent not inserted');
	const [fact] = await database
		.insert(sourceFacts)
		.values({
			candidateId: candidate.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:e2e-${randomUUID()}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'athlete_link',
			consentEventId: grant.id,
			payload: { place: 3 },
			payloadSha256: randomBytes(32).toString('hex'),
			observedAt: signedAt,
			lastVerifiedAt: signedAt,
			status: 'active'
		})
		.returning({ id: sourceFacts.id });
	if (!fact) throw new Error('fact not inserted');
	return { ...account, candidateId: candidate.id, factId: fact.id };
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/login');
}

test('a candidate revokes the FSP import, downloads the data and deletes the account by revoking the processing consent', async ({
	page
}) => {
	const person = await seedCandidate();
	await signIn(page, person.email);

	await page.goto('/me/consents');
	const fsp = page.getByTestId('fsp-consent');
	await expect(fsp.getByTestId('fsp-state')).toHaveAttribute('data-effective', 'true');
	await expect(fsp).toContainText('Достижений ФСП в профиле: 1.');
	await fsp.getByRole('button', { name: 'Отозвать согласие' }).click();
	await expect(page.getByRole('status')).toContainText('Согласие на получение достижений ФСП отозвано');
	await expect(fsp.getByTestId('fsp-state')).toHaveAttribute('data-effective', 'false');
	await expect(fsp).toContainText('Отозвано');
	const [fact] = await db().select().from(sourceFacts).where(eq(sourceFacts.id, person.factId));
	expect(fact).toMatchObject({ status: 'withdrawn', statusReason: 'consent_revoked' });
	const cleanup = await db()
		.select({ status: jobs.status })
		.from(jobs)
		.where(eq(jobs.type, 'consent.revocation_cleanup'))
		.orderBy(desc(jobs.createdAt))
		.limit(1);
	expect(cleanup).toHaveLength(1);
	await expectNoAxeViolations(page);

	await page.goto('/me/export');
	await expectNoAxeViolations(page);
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('data-export-download').click()
	]);
	expect(download.suggestedFilename()).toMatch(/^fsp-career-data-\d{4}-\d{2}-\d{2}\.json$/);
	const exported = JSON.parse(await readFile(await download.path(), 'utf8')) as {
		account: { email: string };
		profile: { id: string };
		facts: { status: string }[];
		consents: { kind: string; action: string }[];
	};
	expect(exported.account.email).toBe(person.email);
	expect(exported.profile.id).toBe(person.candidateId);
	expect(exported.facts).toEqual([expect.objectContaining({ status: 'withdrawn' })]);
	expect(exported.consents).toContainEqual(expect.objectContaining({ kind: 'fsp_import', action: 'revoke' }));
	const journaled = await db()
		.select({ id: auditEvents.id })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'data.exported'), eq(auditEvents.subjectCandidateId, person.candidateId)));
	expect(journaled).toHaveLength(1);

	await page.goto('/me/consents');
	await page.getByTestId('revoke-processing').click();
	await page.waitForURL('**/account/delete?cause=processing_revoked');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Отзыв согласия и удаление профиля');
	await expectNoAxeViolations(page);
	await page.getByLabel('Понимаю, что учётную запись и данные нельзя будет восстановить.').check();
	await page.getByRole('button', { name: 'Отозвать согласие и удалить' }).click();
	await page.waitForURL('**/account/deleted?letter=*');
	await expect(page.getByTestId('account-deleted')).toContainText('Учётная запись удалена');

	const [account] = await db().select({ status: users.status }).from(users).where(eq(users.id, person.userId));
	expect(account?.status).toBe('deletion_pending');
	const [revocation] = await db()
		.select({ id: consentEvents.id })
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, person.candidateId),
				eq(consentEvents.kind, 'pd_processing'),
				eq(consentEvents.action, 'revoke')
			)
		);
	expect(revocation).toBeDefined();
	// The session is gone: the cabinet asks to sign in, and the password no longer opens it.
	await page.goto('/me/profile');
	await page.waitForURL('**/login?**');
	await page.getByLabel('Почта').fill(person.email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await expect(page).toHaveURL(/\/login/);
});

test('the last owner of a company is told to hand the ownership over first', async ({ page }) => {
	const owner = await seedAccount('owner', 'Марина Владелица');
	const company = await createCompany(db(), { displayName: `Е2Е Одиночка ${randomUUID().slice(0, 6)}` });
	await db()
		.insert(companyMembers)
		.values({ companyId: company.id, userId: owner.userId, role: 'owner', status: 'active', joinedAt: new Date() });
	await signIn(page, owner.email);

	await page.goto('/account');
	await page.getByTestId('account-delete').click();
	await page.waitForURL('**/account/delete');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Удаление учётной записи');
	await page.getByLabel('Понимаю, что учётную запись и данные нельзя будет восстановить.').check();
	await page.getByRole('button', { name: 'Удалить учётную запись' }).click();
	await expect(page.getByRole('alert')).toContainText(`единственный владелец компании «${company.displayName}»`);
	const [account] = await db().select({ status: users.status }).from(users).where(eq(users.id, owner.userId));
	expect(account?.status).toBe('active');
});

test('«Мои данные» and the deletion live on the account page, not among the candidate sections', async ({ page }) => {
	const person = await seedCandidate();
	await signIn(page, person.email);

	await page.goto('/me/profile');
	const nav = page.getByRole('navigation', { name: 'Разделы: кандидат' }).first();
	await expect(nav.getByRole('link', { name: 'Профиль' })).toHaveAttribute('href', '/me/profile');
	await expect(nav.getByRole('link', { name: 'Мои данные' })).toHaveCount(0);
	await expect(nav.getByRole('link', { name: 'Удалить учётную запись' })).toHaveCount(0);

	await page.goto('/account');
	await expect(page.getByTestId('account-data-export')).toHaveAttribute('href', '/me/export');
	await expect(page.getByTestId('account-delete')).toHaveAttribute('href', '/account/delete');
	await expectNoAxeViolations(page);
});
