// The pool of a competition partner in the browser against the local infrastructure (`make infra`, legal documents
// from `scripts/seed-legal.ts`): an employer registers and the operator's decisions make the company verified and a
// partner of a competition; a finalist of that competition signs in, reads who will see the card and what, and
// consents; the partner finds the finalist in its pool with the result of the competition and without an invitation
// offered (the company has no vacancy the candidate is visible for); the candidate revokes, and the pool is empty. The
// screens have no accessibility violations.
import { randomBytes, randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, visitorAddress } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { hashPassword } from '$lib/server/auth/password';
import {
	candidates,
	companies,
	competitionPartnerships,
	consentEvents,
	legalDocuments,
	passwordCredentials,
	sourceFacts,
	users
} from '$lib/server/db/schema';

const PASSWORD = 'e2e passphrase long';

// Forms are posted to the public origin of the application (helpers/ports.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { closeDb, db } = await import('$lib/server/db');

test.afterAll(async () => {
	await closeDb();
});

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

/** A 10-digit taxpayer number of an organization with valid check digits. */
function organizationInn(): string {
	const digits = Array.from({ length: 9 }, (_, index) =>
		index === 0 ? 1 + ((randomBytes(1)[0] ?? 0) % 9) : (randomBytes(1)[0] ?? 0) % 10
	);
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const sum = digits.reduce((total, digit, index) => total + digit * (weights[index] ?? 0), 0);
	return [...digits, (sum % 11) % 10].join('');
}

/** Registers an employer through the form; the operator's decisions make the company verified and a partner. */
async function partnerCompany(page: Page, companyName: string, competitionRef: string): Promise<void> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Рекрутер Партнёрский');
	await page.getByLabel('Рабочая почта').fill(`e2e-partner-${randomUUID()}@example.org`);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Название компании').fill(companyName);
	await page.getByLabel('ИНН компании').fill(inn);
	for (const checkbox of await page.getByRole('checkbox', { name: /Принимаю/ }).all()) await checkbox.check();
	await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
	await expect(page).toHaveURL(/\/onboarding/);

	const [company] = await db()
		.update(companies)
		.set({ status: 'verified', verifiedAt: new Date() })
		.where(and(eq(companies.inn, inn), eq(companies.status, 'draft')))
		.returning({ id: companies.id });
	if (!company) throw new Error('company not verified');
	const [operator] = await db()
		.insert(users)
		.values({ status: 'active', emailEnc: randomBytes(40), emailHmac: randomBytes(32).toString('hex') })
		.returning({ id: users.id });
	if (!operator) throw new Error('operator not inserted');
	await db()
		.insert(competitionPartnerships)
		.values({
			companyId: company.id,
			competitionRef,
			competitionSource: 'fsp',
			kind: 'case_provider',
			poolRule: { min_award: 'finalist', stages: ['final'] },
			status: 'active',
			validFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
			grantedBy: operator.id,
			basis: 'Договор о кейсе финала (e2e)'
		});
}

async function currentDocument(kind: 'pd_processing'): Promise<string> {
	const [row] = await db()
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(
			and(eq(legalDocuments.kind, kind), isNotNull(legalDocuments.publishedAt), isNull(legalDocuments.supersededAt))
		)
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!row) throw new Error(`no published ${kind} document: run scripts/seed-legal.ts`);
	return row.id;
}

/** An adult candidate with a password, the processing consent and a finalist's result of the competition. */
async function seedFinalist(competition: { ref: string; title: string }): Promise<string> {
	const database = db();
	const crypto = fieldCrypto();
	const email = `e2e-finalist-${randomUUID()}@example.org`;
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName: 'Финалист e2e'
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	await database
		.insert(passwordCredentials)
		.values({ userId: user.id, hash: await hashPassword(PASSWORD), changedAt: now });
	const [candidate] = await database
		.insert(candidates)
		.values({
			userId: user.id,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: '1999-06-01',
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified'
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	await database.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: await currentDocument('pd_processing'),
		action: 'grant',
		signerKind: 'subject',
		signerUserId: user.id,
		method: 'separate_screen_button',
		evidence: { source: 'e2e' },
		occurredAt: new Date(now.getTime() - 3_600_000)
	});
	const resultId = randomUUID();
	await database.insert(sourceFacts).values({
		candidateId: candidate.id,
		source: 'fsp',
		factType: 'competition_result',
		sourceRecordRef: `fsp:result:${resultId}`,
		eventKey: `fsp:competition:${competition.ref}`,
		sourceSnapshotSha256: randomBytes(32).toString('hex'),
		trustLevel: 'fsp_verified',
		ownershipBasis: 'operator_confirmed',
		payload: {
			result: { id: resultId, competitionId: competition.ref, place: 5, award: 'finalist', status: 'official' },
			competition: {
				id: competition.ref,
				ekpNumber: null,
				title: competition.title,
				discipline: 'product',
				level: 'russian_cup',
				stage: 'final',
				startDate: '2025-11-20',
				online: false
			}
		},
		payloadSha256: randomBytes(32).toString('hex'),
		observedAt: now,
		lastVerifiedAt: now,
		status: 'active'
	});
	return email;
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/login');
}

test('a finalist consents to the partners of the competition, the partner finds them in its pool, and a revocation takes them out', async ({
	page,
	browser
}) => {
	const suffix = randomBytes(3).toString('hex');
	const competition = { ref: `e2e-pool-${suffix}`, title: `Кубок России e2e ${suffix}, финал` };
	const companyName = `Партнёр e2e ${suffix}`;
	await partnerCompany(page, companyName, competition.ref);
	const email = await seedFinalist(competition);
	// Before the finalist consents, the partner's pool is empty: a result alone does not open the card. The only open
	// partnership of the company leads straight to its pool.
	// The company partners a competition: the employer's navigation leads to its pools.
	await page.goto('/company/vacancies');
	await page.getByRole('link', { name: 'Пул партнёра' }).first().click();
	await expect(page).toHaveURL(/\/company\/partner-pools\/[0-9a-f-]{36}$/);
	await expect(page.getByText('В пуле пока никого')).toBeVisible();

	const candidateContext = await browser.newContext({
		baseURL: APP_ORIGIN,
		extraHTTPHeaders: { 'x-forwarded-for': visitorAddress() }
	});
	const candidatePage = await candidateContext.newPage();
	await signIn(candidatePage, email);
	await candidatePage.goto('/me/visibility');
	const section = candidatePage.getByTestId('partner-pool-consent');
	const offer = section.locator(`[data-pool-competition="${competition.ref}"]`);
	await expect(offer).toContainText(competition.title);
	await expect(offer).toContainText(`Кто увидит: ${companyName}`);
	await expect(offer).toContainText('точный результат этого соревнования');
	await expectNoAxeViolations(candidatePage);
	await offer.getByRole('button', { name: 'Даю согласие показать карточку партнёрам' }).click();
	await expect(candidatePage.getByText('Согласие дано: партнёры соревнования видят твою карточку')).toBeVisible();
	await expect(offer.getByTestId('partner-pool-granted')).toBeVisible();

	await page.reload();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Пул финалистов: ${competition.title}`);
	const members = page.getByTestId('pool-members').locator('[data-pool-candidate]');
	await expect(members).toHaveCount(1);
	await expect(members.first().getByTestId('pool-result')).toContainText('Финалист · 5 место · финал');
	await expect(members.first()).not.toContainText('Финалист e2e');
	await expect(members.first().getByTestId('pool-invite')).toContainText('Предложить работу сейчас нельзя');
	await expectNoAxeViolations(page);

	await offer.getByRole('button', { name: 'Убрать карточку из пула партнёров' }).click();
	await expect(candidatePage.getByText('Карточка убрана из пула партнёров этого соревнования.')).toBeVisible();
	await page.reload();
	await expect(page.getByTestId('pool-members').locator('[data-pool-candidate]')).toHaveCount(0);
	await expect(page.getByText('В пуле пока никого')).toBeVisible();
	await candidateContext.close();
});
