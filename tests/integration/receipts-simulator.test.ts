// Receipts of a platform whose FSP is the simulator of a demonstration stand (FSP_ACHIEVEMENTS_ADAPTER=mock) say so in
// the signed statement, and the public check — the API and the page — tells it apart from a receipt of the federation.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { ApiServices } from '$lib/server/api/services';
import { verifyReceiptOperation } from '$lib/server/api/v1/verify';
import { receiptTemplates, sourceFacts, taxonomyVersions, verificationReceipts } from '$lib/server/db/schema';
import {
	checkReceiptSignature,
	createReceiptSigner,
	issueCompanyReceipts,
	loadReceiptTemplates,
	receiptKeySet,
	type LeveledReceiptTemplate,
	type ReceiptSigner
} from '$lib/server/fsp/receipts';
import { runOperation } from '$lib/server/api/operation';
import shippedTemplates from '../../taxonomy/receipt-templates.json';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createCompany, createTaxonomyVersion, randomSha256 } from '../helpers/factories';

// The page and the configured signer read `config()`: the environment of a stand whose FSP is the simulator.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { configuredReceiptSigner } = await import('$lib/server/fsp/receipts');
const { load: verifyPage } = await import('../../src/routes/verify/[handle]/+page.server');
const { testEnvironment } = await import('../helpers/environment');

/** The signing key of the test environment (`RECEIPT_SIGNING_KEYS=test-1:…`). */
const SEED = Buffer.alloc(32, 3);
const federation = createReceiptSigner({ issuer: 'http://localhost:57173', keyId: 'test-1', seed: SEED });
const simulator = createReceiptSigner({
	issuer: 'http://localhost:57173',
	keyId: 'test-1',
	seed: SEED,
	fspSimulator: true
});

const SIMULATED_FSP = {
	FSP_ID_ISSUER: 'http://fsp-mock.localhost:57610/realms/fsp',
	FSP_ID_CLIENT_ID: 'fsp-career',
	FSP_ID_CLIENT_SECRET: 'local-only-fsp-id-client-secret-0000',
	FSP_ID_REDIRECT_URI: 'http://localhost:57173/auth/fsp/callback',
	FSP_ACHIEVEMENTS_ADAPTER: 'mock',
	FSP_ACHIEVEMENTS_BASE_URL: 'http://fsp-mock.localhost:57610',
	FSP_WEBHOOK_SECRET: 'local-only-fsp-webhook-secret-00000000',
	FSP_ASSERTION_SECRET: 'local-only-fsp-assertion-secret-0000000'
};

let database: TestDatabase;
let templates: Map<string, LeveledReceiptTemplate>;

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl'), ...SIMULATED_FSP }));
	const { db } = database;
	const version = await createTaxonomyVersion(db);
	await db.insert(receiptTemplates).values(
		shippedTemplates.templates.map((template) => ({
			taxonomyVersionId: version.id,
			source: template.source,
			factType: template.factType,
			asserts: template.asserts,
			doesNotAssert: template.doesNotAssert
		}))
	);
	await db
		.update(taxonomyVersions)
		.set({ status: 'published', publishedAt: new Date() })
		.where(eq(taxonomyVersions.id, version.id));
	templates = await loadReceiptTemplates(db);
});

afterAll(async () => {
	await closeDb();
	await database.drop();
});

async function receiptOfFspResult(signer: ReceiptSigner) {
	const { db } = database;
	const candidate = await createCandidate(db);
	const competitionId = randomSha256().slice(0, 8);
	const [fact] = await db
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
				result: { id: 'r-1', competitionId, place: 1, team: null, award: 'winner', status: 'official' },
				competition: {
					id: competitionId,
					ekpNumber: null,
					title: 'Кубок России по спортивному программированию',
					discipline: 'product',
					level: 'russian_cup',
					stage: 'final',
					format: 'team',
					startDate: '2025-10-01',
					online: false
				}
			},
			payloadSha256: randomSha256(),
			sourceSnapshotSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date('2026-09-20T10:00:00Z'),
			occurredOn: '2025-10-01',
			status: 'active'
		})
		.returning();
	if (!fact) throw new Error('fact not inserted');
	const company = await createCompany(db);
	const outcome = await issueCompanyReceipts(db, signer, templates, {
		companyId: company.id,
		candidateId: candidate.id,
		factIds: [fact.id],
		exactFactIds: []
	});
	expect(outcome.issued).toBe(1);
	const [receipt] = await db
		.select()
		.from(verificationReceipts)
		.where(and(eq(verificationReceipts.factId, fact.id), eq(verificationReceipts.audienceCompanyId, company.id)));
	if (!receipt) throw new Error('receipt not issued');
	return receipt;
}

async function checkThroughApi(handle: string) {
	const url = new URL(`http://app.test/api/v1/verify/${handle}`);
	const response = await runOperation(verifyReceiptOperation, { db: database.db } as unknown as ApiServices, {
		request: new Request(url),
		url,
		params: { handle },
		locals: { requestId: 'req-test', actor: { kind: 'anonymous' } },
		getClientAddress: () => '127.0.0.1'
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { source_simulator: boolean; statement: Record<string, unknown> };
}

async function openPage(handle: string) {
	const data = await verifyPage({
		params: { handle },
		locals: { requestId: 'req-test', actor: { kind: 'anonymous' }, rateLimited: false },
		getClientAddress: () => '127.0.0.1',
		request: new Request(`http://localhost/verify/${handle}`),
		setHeaders: () => {}
	} as unknown as Parameters<typeof verifyPage>[0]);
	if (!data) throw new Error('the page returned no data');
	return data;
}

describe('receipts of the simulator', () => {
	it('are signed by the configured signer of a stand whose FSP is the simulator', () => {
		expect(configuredReceiptSigner().fspSimulator).toBe(true);
	});

	it('say under the signature that the source is the simulator, and the check says it too', async () => {
		const receipt = await receiptOfFspResult(simulator);
		const statement = receipt.statement as Record<string, unknown>;
		expect(statement).toMatchObject({ source: 'fsp', source_simulator: true });
		// The mark is a part of the signed statement: removing it breaks the signature.
		const keys = receiptKeySet(new Map([['test-1', SEED]]));
		expect(checkReceiptSignature(statement, receipt.signature, 'test-1', keys)).toBe('valid');
		const unmarked = { ...statement };
		delete unmarked.source_simulator;
		expect(checkReceiptSignature(unmarked, receipt.signature, 'test-1', keys)).toBe('invalid');

		const answer = await checkThroughApi(receipt.handle);
		expect(answer.source_simulator).toBe(true);
		expect(answer.statement.source_simulator).toBe(true);

		expect(await openPage(receipt.handle)).toMatchObject({ statement: { simulator: true }, signature: 'valid' });
	});

	it('are told apart from receipts of the federation', async () => {
		const receipt = await receiptOfFspResult(federation);
		expect(receipt.statement).not.toHaveProperty('source_simulator');
		const answer = await checkThroughApi(receipt.handle);
		expect(answer.source_simulator).toBe(false);
		expect(answer.statement).not.toHaveProperty('source_simulator');
		expect(await openPage(receipt.handle)).toMatchObject({ statement: { simulator: false } });
	});
});
