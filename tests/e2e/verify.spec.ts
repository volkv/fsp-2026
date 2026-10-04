// Reads a browser opens refuse a request over the rate limit in the layout of the site, with the limit headers: the
// public receipt page and the catalog pages answer `429` with the error page (their `__data.json` carries the error for
// the router), the sign-in through FSP ID sends the browser to the sign-in page, which explains the refusal. The
// verification API answers the budget of the receipt page with its JSON error. A receipt of the FSP simulator says so on
// the page and in the API.
//
// The limit is counted per client address, which the application reads from `X-Forwarded-For` (helpers/test.ts). The
// requests here carry an address of their own, so they exhaust a budget no other test spends.
import { request as httpRequest } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { sourceFacts, verificationReceipts } from '$lib/server/db/schema';
import { createReceiptSigner, issueCompanyReceipts, loadReceiptTemplates } from '$lib/server/fsp/receipts';
import { createCandidate, createCompany, randomSha256 } from '../helpers/factories';
import { expect, test, visitorAddress } from './helpers/test';
import { APP_PORT } from './helpers/ports';

// `$env/dynamic/private` of the seeding modules is resolved by the hook of playwright.config.ts.
const { config } = await import('$lib/server/config');
const { closeDb, db } = await import('$lib/server/db');

test.afterAll(async () => {
	await closeDb();
});

/** Budgets of `receiptVerify`, `catalog` and `fspSignIn` (src/lib/server/http/rate-limit.ts). */
const VERIFY_LIMIT = 30;
const CATALOG_LIMIT = 60;
const FSP_SIGN_IN_LIMIT = 60;

interface Answer {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function get(path: string, address: string, accept: string): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const headers = { accept, 'x-forwarded-for': address };
		const req = httpRequest({ host: '127.0.0.1', port: APP_PORT, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
			});
			res.on('error', reject);
		});
		req.on('error', reject);
		req.end();
	});
}

test('a receipt page over the rate limit renders the refusal in the layout of the site', async () => {
	const address = visitorAddress();
	// A handle of the wrong form is refused before any lookup, so spending the budget costs no database work.
	for (let hit = 1; hit <= VERIFY_LIMIT; hit++) {
		const answer = await get('/verify/not-a-handle', address, 'text/html');
		expect(answer.status, `hit ${hit}`).toBe(404);
	}

	const page = await get('/verify/not-a-handle', address, 'text/html');
	expect(page.status).toBe(429);
	expect(page.headers['content-type']).toMatch(/^text\/html/);
	const requestId = page.headers['x-request-id'];
	expect(typeof requestId).toBe('string');
	expect(page.headers['content-security-policy']).toBeDefined();
	expect(page.headers['x-content-type-options']).toBe('nosniff');
	expect(page.headers['retry-after']).toMatch(/^\d+$/);
	expect(page.headers['ratelimit-remaining']).toBe('0');
	expect(page.body).toContain('data-testid="error-page"');
	expect(page.body).toContain('Слишком много запросов');
	expect(page.body).toContain(`>${requestId as string}</span>`);

	// The data of the page for client-side navigation is refused by the page too.
	const data = await get('/verify/not-a-handle/__data.json', address, 'application/json');
	expect(data.status).toBe(200);
	expect(data.body).toContain('"status":429');

	// The API shares the budget and keeps its JSON error.
	const api = await get('/api/v1/verify/not-a-handle', address, 'application/json');
	expect(api.status).toBe(429);
	expect(api.headers['content-type']).toMatch(/json/);
	expect(JSON.parse(api.body)).toMatchObject({ error: { code: 'rate_limited' } });
});

/** Headers of a refusal over the limit: when to retry, the spent budget, and nothing kept by a cache. */
function expectLimitHeaders(answer: Answer): void {
	expect(answer.headers['retry-after']).toMatch(/^\d+$/);
	expect(answer.headers['ratelimit-remaining']).toBe('0');
	expect(answer.headers['cache-control']).toBe('no-store');
}

test('a catalog page over the limit of its reader renders the refusal in the layout of the site', async () => {
	// An anonymous reader is counted by the address; the page sends it to the sign-in, which costs nothing.
	const address = visitorAddress();
	for (let hit = 1; hit <= CATALOG_LIMIT; hit++) {
		const answer = await get('/company/candidates', address, 'text/html');
		expect(answer.status, `hit ${String(hit)}`).toBe(303);
	}
	const page = await get('/company/candidates', address, 'text/html');
	expect(page.status).toBe(429);
	expect(page.headers['content-type']).toMatch(/^text\/html/);
	expectLimitHeaders(page);
	const requestId = page.headers['x-request-id'];
	expect(typeof requestId).toBe('string');
	expect(page.body).toContain('data-testid="error-page"');
	expect(page.body).toContain('Слишком много запросов подряд');
	expect(page.body).toContain(`>${requestId as string}</span>`);

	// The data of the page for client-side navigation carries the same refusal, which the router shows in the layout.
	const data = await get('/company/candidates/__data.json', address, 'application/json');
	expect(data.status).toBe(200);
	expectLimitHeaders(data);
	expect(data.body).toContain('"status":429');
	expect(data.body).toContain('Слишком много запросов подряд');
});

test('the sign-in through FSP ID over the limit of the address is explained on the sign-in page', async ({ page }) => {
	const address = visitorAddress();
	// The callback without a flow is turned back at once and shares the budget with the start.
	for (let hit = 1; hit <= FSP_SIGN_IN_LIMIT; hit++) {
		const answer = await get('/auth/fsp/callback', address, 'text/html');
		expect(answer.status, `hit ${String(hit)}`).toBe(303);
		expect(answer.headers.location, `hit ${String(hit)}`).not.toBe('/login?error=fsp_rate_limited');
	}
	// Over the limit neither the start nor the callback reaches the provider: both send the browser back to sign in.
	for (const path of ['/auth/fsp', '/auth/fsp/callback']) {
		const refused = await get(path, address, 'text/html');
		expect(refused.status, path).toBe(303);
		expect(refused.headers.location, path).toBe('/login?error=fsp_rate_limited');
		expectLimitHeaders(refused);
	}
	await page.goto('/login?error=fsp_rate_limited');
	await expect(page.getByRole('main')).toContainText('Слишком много попыток входа через ФСП ID с этого адреса');

	// Another address has a budget of its own: its start goes on to the provider.
	const other = await get('/auth/fsp', visitorAddress(), 'text/html');
	expect(other.status).toBe(303);
	expect(other.headers.location).not.toBe('/login?error=fsp_rate_limited');
});

test('a receipt of the FSP simulator says so on the page and in the API', async ({ page, request }) => {
	const database = db();
	const settings = config();
	const keyId = settings.crypto.activeReceiptSigningKeyId;
	const seed = settings.crypto.receiptSigningKeys.get(keyId);
	if (!seed) throw new Error('the active receipt signing key is missing');
	const signer = createReceiptSigner({ issuer: settings.appOrigin, keyId, seed, fspSimulator: true });
	const candidate = await createCandidate(database);
	const company = await createCompany(database);
	const competitionId = randomSha256().slice(0, 12);
	const [fact] = await database
		.insert(sourceFacts)
		.values({
			candidateId: candidate.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
			eventKey: `fsp:competition:${competitionId}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {
				result: { id: 'e2e-r-1', competitionId, place: 1, team: null, award: 'winner', status: 'official' },
				competition: {
					id: competitionId,
					ekpNumber: null,
					title: 'Кубок России по спортивному программированию',
					discipline: 'algorithmic',
					level: 'russian_cup',
					stage: 'final',
					format: 'individual',
					startDate: '2025-10-01',
					online: false
				}
			},
			payloadSha256: randomSha256(),
			sourceSnapshotSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			occurredOn: '2025-10-01',
			status: 'active'
		})
		.returning({ id: sourceFacts.id });
	if (!fact) throw new Error('fact not inserted');
	const outcome = await issueCompanyReceipts(database, signer, await loadReceiptTemplates(database), {
		companyId: company.id,
		candidateId: candidate.id,
		factIds: [fact.id],
		exactFactIds: []
	});
	expect(outcome.issued).toBe(1);
	const [receipt] = await database
		.select({ handle: verificationReceipts.handle })
		.from(verificationReceipts)
		.where(and(eq(verificationReceipts.factId, fact.id), eq(verificationReceipts.audienceCompanyId, company.id)));
	if (!receipt) throw new Error('receipt not issued');

	await page.goto(`/verify/${receipt.handle}`);
	await expect(page.getByTestId('receipt-signature')).toHaveAttribute('data-signature', 'valid');
	await expect(page.getByTestId('receipt-simulator-notice')).toContainText('Источник — имитатор ФСП');
	await expect(page.getByTestId('receipt-simulator')).toHaveText('Имитатор ФСП');
	await expect(page.getByRole('article')).toContainText('демонстрационный имитатор ФСП');

	const api = await request.get(`/api/v1/verify/${receipt.handle}`);
	expect(api.status()).toBe(200);
	expect(await api.json()).toMatchObject({ source_simulator: true, statement: { source_simulator: true } });
});
