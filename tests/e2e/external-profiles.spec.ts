// Public profiles in the candidate's profile against the local infrastructure: a one-time code is issued through the
// page and checked against a stand-in of the Codeforces API this file serves (playwright.config.ts points the
// application at it), a verified profile shows what its reading found, its receipt and when it was read, a source that
// did not answer is a stated status, and unlinking withdraws the facts.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { and, desc, eq, lte } from 'drizzle-orm';
import { hashPassword } from '$lib/server/auth/password';
import {
	candidates,
	consentEvents,
	externalProfiles,
	legalDocuments,
	passwordCredentials,
	sourceFacts,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import { expect, test } from './helpers/test';
import { APP_ORIGIN, PUBLIC_PROFILES_STUB_PORT } from './helpers/ports';

// `$env/dynamic/private` for the server modules comes from the hook of playwright.config.ts.
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { closeDb, db } = await import('$lib/server/db');

const PASSWORD = 'e2e passphrase long';

// Forms are posted to the public origin of the application (playwright.config.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

// One worker serves the stand-in on its fixed port.
test.describe.configure({ mode: 'serial' });

/** Codeforces users of the stand-in by lowercase handle: what `user.info` answers. */
const codeforcesUsers = new Map<string, { handle: string; firstName?: string; rating: number; maxRating: number }>();
let stub: Server;

test.beforeAll(async () => {
	stub = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://stub');
		const handle = (url.searchParams.get('handles') ?? url.searchParams.get('handle') ?? '').toLowerCase();
		const user = codeforcesUsers.get(handle);
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
		};
		if (!url.pathname.startsWith('/codeforces/')) {
			send(404, { message: 'Not Found' });
		} else if (!user) {
			send(400, { status: 'FAILED', comment: `handles: User with handle ${handle} not found` });
		} else if (url.pathname === '/codeforces/user.info') {
			send(200, {
				status: 'OK',
				result: [{ ...user, rank: 'expert', maxRank: 'candidate master', registrationTimeSeconds: 1_600_000_000 }]
			});
		} else if (url.pathname === '/codeforces/user.rating') {
			send(200, { status: 'OK', result: [{ contestId: 1, ratingUpdateTimeSeconds: 1_789_000_000 }] });
		} else {
			const solved = Array.from({ length: 40 }, (_, i) => ({
				verdict: 'OK',
				problem: { contestId: 1000 + i, index: 'A' }
			}));
			send(200, { status: 'OK', result: solved });
		}
	});
	await new Promise<void>((resolve) => stub.listen(PUBLIC_PROFILES_STUB_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => {
		stub.closeAllConnections();
		stub.close(() => {
			resolve();
		});
	});
	await closeDb();
});

async function seedCandidate(): Promise<{ email: string; candidateId: string }> {
	const database = db();
	const crypto = fieldCrypto();
	const email = `e2e-profiles-${randomUUID()}@example.org`;
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName: 'Олег Профилев'
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
			birthDate: '1999-02-11',
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified'
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	const [document] = await database
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(and(eq(legalDocuments.kind, 'pd_processing'), lte(legalDocuments.publishedAt, now)))
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!document) throw new Error('no published pd_processing document: run scripts/seed-legal.ts');
	await database.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: document.id,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: user.id,
		method: 'separate_screen_button',
		evidence: { source: 'e2e' },
		occurredAt: new Date(now.getTime() - 3_600_000)
	});
	return { email, candidateId: candidate.id };
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/login');
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A verified profile with the fact its reading wrote, as the check and the reading leave them. */
async function seedVerified(
	candidateId: string,
	platform: 'codeforces' | 'github',
	handle: string,
	payload: Record<string, unknown>,
	sync: { status: 'ok' | 'source_unavailable'; error: string | null }
): Promise<{ profileId: string; factId: string }> {
	const database = db();
	const now = new Date();
	const [profile] = await database
		.insert(externalProfiles)
		.values({
			candidateId,
			platform,
			handle,
			ownershipStatus: 'verified',
			ownershipMethod: 'handle_challenge',
			verifiedAt: new Date(now.getTime() - 86_400_000),
			syncStatus: sync.status,
			syncError: sync.error,
			syncCheckedAt: now,
			syncedAt: new Date(now.getTime() - 86_400_000)
		})
		.returning({ id: externalProfiles.id });
	if (!profile) throw new Error('profile not inserted');
	const [fact] = await database
		.insert(sourceFacts)
		.values({
			candidateId,
			source: platform,
			factType: platform === 'codeforces' ? 'platform_rating' : 'repo_languages',
			sourceRecordRef: `${platform}:user:${handle.toLowerCase()}`,
			eventKey: `profile:${platform}:${handle.toLowerCase()}`,
			trustLevel: 'public_verifiable',
			ownershipBasis: 'handle_challenge',
			ownershipRef: profile.id,
			payload,
			payloadSha256: sha256(payload),
			observedAt: now,
			lastVerifiedAt: now,
			status: 'active'
		})
		.returning({ id: sourceFacts.id });
	if (!fact) throw new Error('fact not inserted');
	return { profileId: profile.id, factId: fact.id };
}

test('a one-time code is issued through the page and a pending link can be cancelled', async ({ page }) => {
	const { email, candidateId } = await seedCandidate();
	await signIn(page, email);
	await page.goto('/me/profile');

	const section = page.getByTestId('external-profiles');
	await expect(section.getByRole('heading', { name: 'Публичные профили' })).toBeVisible();
	await expect(section).toContainText('одноразовым кодом');

	const form = section.getByTestId('external-profile-link');
	await form.getByLabel('Платформа').selectOption('github');
	await form.getByLabel('Хэндл или ссылка на профиль').fill('https://github.com/E2E-Someone');
	await form.getByRole('button', { name: 'Получить код' }).click();

	const card = section.getByTestId('external-profile');
	await expect(card).toHaveAttribute('data-status', 'unverified');
	await expect(card.getByRole('link', { name: 'E2E-Someone' })).toBeVisible();
	const code = (await card.getByTestId('challenge-code').textContent())?.trim() ?? '';
	expect(code).toMatch(/^fsp[a-z]{12}$/);
	await expect(card).toContainText('gist');
	await expect(card).toContainText('проверок осталось: 10');
	const [row] = await db()
		.select({ code: externalProfiles.challengeCode, status: externalProfiles.ownershipStatus })
		.from(externalProfiles)
		.where(eq(externalProfiles.candidateId, candidateId));
	expect(row).toEqual({ code, status: 'unverified' });

	const axe = await new AxeBuilder({ page })
		.include('[data-testid="external-profiles"]')
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	expect(axe.violations.map((v) => v.id)).toEqual([]);

	await card.getByRole('button', { name: 'Отменить' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Отвязать' }).click();
	await expect(section.getByTestId('external-profile')).toHaveCount(0);
	await expect(section).toContainText('Профиль отвязан');
	expect(await db().select().from(externalProfiles).where(eq(externalProfiles.candidateId, candidateId))).toHaveLength(
		0
	);
});

test('a verified profile shows its reading, a source that did not answer, and unlinking withdraws the facts', async ({
	page
}) => {
	const { email, candidateId } = await seedCandidate();
	const codeforces = await seedVerified(
		candidateId,
		'codeforces',
		'E2E_Coder',
		{
			account: { platform: 'codeforces', login: 'E2E_Coder', rating: 1850 },
			maxRating: 1932,
			rank: 'expert',
			maxRank: 'candidate master',
			solvedCount: 412,
			ratedContests: 57,
			lastRatedOn: '2026-09-12',
			registeredOn: '2019-01-01'
		},
		{ status: 'ok', error: null }
	);
	await seedVerified(
		candidateId,
		'github',
		'e2e-dev',
		{
			login: 'e2e-dev',
			publicRepos: 14,
			ownRepos: 11,
			reposRead: 5,
			languages: [
				{ name: 'TypeScript', share: 0.62, repos: 6 },
				{ name: 'Go', share: 0.31, repos: 3 }
			],
			lastPushMonth: '2026-09',
			reposPushedLastYear: 7,
			createdOn: '2018-04-02'
		},
		{ status: 'source_unavailable', error: 'rate_limited' }
	);
	await signIn(page, email);
	await page.goto('/me/profile');

	const section = page.getByTestId('external-profiles');
	const cf = section.locator('[data-testid="external-profile"][data-platform="codeforces"]');
	await expect(cf).toHaveAttribute('data-status', 'verified');
	await expect(cf.getByTestId('profile-summary')).toContainText('1850 (максимум 1932)');
	await expect(cf.getByTestId('profile-summary')).toContainText('412');
	await expect(cf.getByText('Публичный профиль')).toBeVisible();

	const gh = section.locator('[data-testid="external-profile"][data-platform="github"]');
	await expect(gh).toHaveAttribute('data-sync', 'source_unavailable');
	await expect(gh).toContainText('Источник недоступен');
	await expect(gh).toContainText('ограничил частоту запросов');
	await expect(gh.getByTestId('profile-summary')).toContainText('TypeScript 62% · Go 31%');
	await expect(gh).toContainText('не подтверждение авторства каждой строки');
	// Both platforms are linked: nothing is left to link.
	await expect(section.getByTestId('external-profile-link')).toHaveCount(0);

	await cf.getByRole('button', { name: 'Отвязать' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Отвязать' }).click();
	await expect(section.locator('[data-platform="codeforces"]')).toHaveCount(0);
	const [fact] = await db()
		.select({ status: sourceFacts.status, reason: sourceFacts.statusReason })
		.from(sourceFacts)
		.where(eq(sourceFacts.id, codeforces.factId));
	expect(fact).toEqual({ status: 'withdrawn', reason: 'profile_unlinked' });
	await expect(section.getByTestId('external-profile-link')).toBeVisible();
});

test('a Codeforces code is checked through the page: not found first, then the profile is verified and read', async ({
	page
}) => {
	const { email, candidateId } = await seedCandidate();
	const handle = `E2E_${randomUUID().slice(0, 8)}`;
	codeforcesUsers.set(handle.toLowerCase(), { handle, rating: 1810, maxRating: 1955 });
	await signIn(page, email);
	await page.goto('/me/profile');

	const section = page.getByTestId('external-profiles');
	const form = section.getByTestId('external-profile-link');
	await form.getByLabel('Платформа').selectOption('codeforces');
	await form.getByLabel('Хэндл или ссылка на профиль').fill(`https://codeforces.com/profile/${handle}`);
	await form.getByRole('button', { name: 'Получить код' }).click();
	const card = section.locator('[data-testid="external-profile"][data-platform="codeforces"]');
	const code = (await card.getByTestId('challenge-code').textContent())?.trim() ?? '';
	expect(code).toMatch(/^fsp[a-z]{12}$/);

	// The code is not in the profile yet.
	await card.getByRole('button', { name: 'Проверить' }).click();
	await expect(card).toContainText('Код не найден в профиле Codeforces', { timeout: 15_000 });
	await expect(card).toHaveAttribute('data-status', 'unverified');

	codeforcesUsers.set(handle.toLowerCase(), { handle, firstName: `Олег ${code}`, rating: 1810, maxRating: 1955 });
	await card.getByRole('button', { name: 'Проверить' }).click();
	await expect(card).toHaveAttribute('data-status', 'verified', { timeout: 15_000 });
	await expect(card).toContainText('Профиль Codeforces подтверждён');
	await expect(card.getByTestId('profile-summary')).toContainText('1810 (максимум 1955)');
	await expect(card.getByTestId('profile-summary')).toContainText('40');
	await card.getByText('Квитанция проверки: что подтверждено и чего нет').click();
	await expect(card.getByTestId('profile-receipt')).toContainText('candidate master (1900–2099)');

	const [fact] = await db()
		.select({ id: sourceFacts.id, trust: sourceFacts.trustLevel, status: sourceFacts.status })
		.from(sourceFacts)
		.where(eq(sourceFacts.candidateId, candidateId));
	expect(fact).toMatchObject({ trust: 'public_verifiable', status: 'active' });
	const receipts = await db()
		.select({ id: verificationReceipts.id })
		.from(verificationReceipts)
		.where(eq(verificationReceipts.factId, fact?.id ?? ''));
	expect(receipts).toHaveLength(1);
});
