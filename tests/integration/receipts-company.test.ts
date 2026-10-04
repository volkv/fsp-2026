import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { receiptTemplates, sourceFacts, taxonomyVersions, verificationReceipts } from '$lib/server/db/schema';
import {
	checkReceiptSignature,
	createReceiptSigner,
	issueCompanyReceipts,
	loadReceiptTemplates,
	receiptKeySet,
	verifyReceipt,
	type LeveledReceiptTemplate,
	type ReceiptJwk
} from '$lib/server/fsp/receipts';
import shippedTemplates from '../../taxonomy/receipt-templates.json';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createCompany, createTaxonomyVersion, randomSha256 } from '../helpers/factories';

// The routes read `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { loadCatalogCard } = await import('$lib/server/employer/card');
const { GET: receiptKeysRoute } = await import('../../src/routes/.well-known/receipt-keys.json/+server');
const { load: verifyPage } = await import('../../src/routes/verify/[handle]/+page.server');
const { testEnvironment } = await import('../helpers/environment');

let database: TestDatabase;
let templates: Map<string, LeveledReceiptTemplate>;

/** The signing key of the test environment (`RECEIPT_SIGNING_KEYS=test-1:…`). */
const SEED = Buffer.alloc(32, 3);
const signer = createReceiptSigner({ issuer: 'http://localhost:57173', keyId: 'test-1', seed: SEED });

const TEAM_NAME = 'Команда Иванова';

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
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

async function candidateWithResult(
	overrides: Parameters<typeof createCandidate>[1] = {},
	team: Record<string, unknown> | null = { id: 't-1', name: TEAM_NAME }
) {
	const { db } = database;
	const candidate = await createCandidate(db, overrides);
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
				result: {
					id: 'r-1',
					competitionId,
					place: 2,
					team,
					award: 'prize',
					status: 'official'
				},
				competition: {
					id: competitionId,
					ekpNumber: null,
					title: 'Чемпионат России по спортивному программированию',
					discipline: 'algorithmic',
					level: 'russian_championship',
					stage: 'final',
					format: team === null ? 'individual' : 'team',
					startDate: '2025-11-10',
					online: false
				}
			},
			payloadSha256: randomSha256(),
			sourceSnapshotSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date('2026-09-20T10:11:12.345Z'),
			occurredOn: '2025-11-10',
			status: 'active'
		})
		.returning();
	if (!fact) throw new Error('fact not inserted');
	return { candidate, fact };
}

async function receiptsOf(factId: string, companyId: string) {
	return database.db
		.select()
		.from(verificationReceipts)
		.where(and(eq(verificationReceipts.factId, factId), eq(verificationReceipts.audienceCompanyId, companyId)));
}

async function keySet(): Promise<{ keys: ReceiptJwk[] }> {
	const response = await receiptKeysRoute({} as Parameters<typeof receiptKeysRoute>[0]);
	return (await response.json()) as { keys: ReceiptJwk[] };
}

async function openPage(handle: string) {
	return verifyPage({
		params: { handle },
		locals: { requestId: 'req-test', actor: { kind: 'anonymous' } },
		getClientAddress: () => '127.0.0.1',
		request: new Request(`http://localhost/verify/${handle}`),
		setHeaders: () => {}
	} as unknown as Parameters<typeof verifyPage>[0]);
}

describe('receipts for companies', () => {
	it('gives two companies different handles and commitments for one fact, so they cannot link it', async () => {
		const { db } = database;
		const { candidate, fact } = await candidateWithResult();
		const first = await createCompany(db);
		const second = await createCompany(db);
		for (const company of [first, second]) {
			const outcome = await issueCompanyReceipts(db, signer, templates, {
				companyId: company.id,
				candidateId: candidate.id,
				factIds: [fact.id],
				exactFactIds: []
			});
			expect(outcome).toEqual({ issued: 1, existing: 0, ineligible: 0 });
		}
		const [a] = await receiptsOf(fact.id, first.id);
		const [b] = await receiptsOf(fact.id, second.id);
		if (!a || !b) throw new Error('receipts not issued');

		expect(a.handle).not.toBe(b.handle);
		expect(a.signature).not.toBe(b.signature);
		const statementA = a.statement as Record<string, unknown>;
		const statementB = b.statement as Record<string, unknown>;
		expect(statementA.record_commitment).not.toBe(statementB.record_commitment);
		expect(statementA.snapshot_commitment).not.toBe(statementB.snapshot_commitment);
		// Nothing else is specific to the candidate: the rest is what any such result of that season says.
		const common = (s: Record<string, unknown>) => ({ ...s, record_commitment: null, snapshot_commitment: null });
		expect(common(statementA)).toEqual(common(statementB));
		expect(statementA.verified_at).toBe('2026-09-20');
		const text = JSON.stringify([statementA, statementB]);
		for (const secret of [fact.sourceRecordRef, fact.sourceSnapshotSha256, candidate.id, TEAM_NAME]) {
			expect(text).not.toContain(secret);
		}

		// A repeated view returns the receipt already issued for this company.
		const again = await issueCompanyReceipts(db, signer, templates, {
			companyId: first.id,
			candidateId: candidate.id,
			factIds: [fact.id],
			exactFactIds: []
		});
		expect(again).toEqual({ issued: 0, existing: 1, ineligible: 0 });
		expect(await receiptsOf(fact.id, first.id)).toHaveLength(1);
	});

	it('issues one receipt of a fact, at the level the card shows it', async () => {
		const { db } = database;
		const { candidate, fact } = await candidateWithResult();
		const company = await createCompany(db);
		await issueCompanyReceipts(db, signer, templates, {
			companyId: company.id,
			candidateId: candidate.id,
			factIds: [fact.id],
			exactFactIds: [fact.id]
		});
		// One receipt at the level the fact is shown: an exact fact gets no generalized receipt beside it.
		const rows = await receiptsOf(fact.id, company.id);
		expect(rows.map((row) => row.disclosureLevel)).toEqual(['exact']);
		const exact = rows[0]?.statement as Record<string, unknown>;
		expect(exact.asserts).toMatchObject({
			competition: 'Чемпионат России по спортивному программированию',
			place: 2,
			stage: 'final'
		});
		expect(exact.record_commitment).toBe(fact.sourceRecordRef);

		const other = await createCompany(db);
		await issueCompanyReceipts(db, signer, templates, {
			companyId: other.id,
			candidateId: candidate.id,
			factIds: [fact.id],
			exactFactIds: []
		});
		const [generalized] = await receiptsOf(fact.id, other.id);
		expect(generalized?.disclosureLevel).toBe('generalized');
		expect((generalized?.statement as Record<string, unknown>).asserts).not.toHaveProperty('place');
		expect((generalized?.statement as Record<string, unknown>).asserts).not.toHaveProperty('competition');
	});

	it('says what it does not assert by the kind of the result and the role in the team', async () => {
		const { db } = database;
		const company = await createCompany(db);
		const limitsOf = async (team: Record<string, unknown> | null) => {
			const { candidate, fact } = await candidateWithResult({}, team);
			await issueCompanyReceipts(db, signer, templates, {
				companyId: company.id,
				candidateId: candidate.id,
				factIds: [fact.id],
				exactFactIds: []
			});
			const [row] = await receiptsOf(fact.id, company.id);
			return (row?.statement as { does_not_assert: string[] }).does_not_assert;
		};
		const common = ['владение конкретным языком программирования', 'коммерческий опыт'];

		// A personal result: no contribution to a team solution to leave unconfirmed.
		const personal = await limitsOf(null);
		expect(personal).not.toContain('личный вклад в командное решение');
		expect(personal).toEqual(expect.arrayContaining(['работу в команде', ...common]));

		const captain = await limitsOf({ id: 't-2', name: TEAM_NAME, role: 'captain' });
		expect(captain).toEqual(expect.arrayContaining(['личный вклад в командное решение', ...common]));
		expect(captain).not.toContain('работу в команде');
		expect(captain.some((text) => text.includes('запасной') || text.includes('тренер'))).toBe(false);

		const reserve = await limitsOf({ id: 't-3', name: TEAM_NAME, role: 'reserve' });
		expect(reserve).toContain('личный вклад в командное решение');
		expect(reserve).toContain('участие в решении задач: запасной мог не выходить на соревнование');

		// The source did not pass the role: the receipt says so.
		expect(await limitsOf({ id: 't-4', name: TEAM_NAME })).toContain('роль в команде: источник её не передал');
	});

	it('answers a withdrawn fact as not valid, an annulled one as annulled, a new version as superseded', async () => {
		const { db } = database;
		const company = await createCompany(db);
		const statusAfter = async (change: Partial<typeof sourceFacts.$inferInsert>) => {
			const { candidate, fact } = await candidateWithResult();
			await issueCompanyReceipts(db, signer, templates, {
				companyId: company.id,
				candidateId: candidate.id,
				factIds: [fact.id],
				exactFactIds: []
			});
			const [receipt] = await receiptsOf(fact.id, company.id);
			if (!receipt) throw new Error('receipt not issued');
			expect((await verifyReceipt(db, receipt.handle))?.status).toBe('valid');
			await db.update(sourceFacts).set(change).where(eq(sourceFacts.id, fact.id));
			return (await verifyReceipt(db, receipt.handle))?.status;
		};
		expect(await statusAfter({ status: 'withdrawn' })).toBe('not_valid');
		expect(await statusAfter({ status: 'annulled' })).toBe('annulled');
		expect(await statusAfter({ payloadSha256: randomSha256() })).toBe('superseded');

		// A withdrawn fact gets no new receipts.
		const { candidate, fact } = await candidateWithResult();
		await db.update(sourceFacts).set({ status: 'withdrawn' }).where(eq(sourceFacts.id, fact.id));
		const outcome = await issueCompanyReceipts(db, signer, templates, {
			companyId: company.id,
			candidateId: candidate.id,
			factIds: [fact.id],
			exactFactIds: []
		});
		expect(outcome).toEqual({ issued: 0, existing: 0, ineligible: 1 });
	});

	it('verifies the signature with the published key set, and not a changed statement', async () => {
		const { db } = database;
		const { candidate, fact } = await candidateWithResult();
		const company = await createCompany(db);
		await issueCompanyReceipts(db, signer, templates, {
			companyId: company.id,
			candidateId: candidate.id,
			factIds: [fact.id],
			exactFactIds: []
		});
		const [receipt] = await receiptsOf(fact.id, company.id);
		if (!receipt) throw new Error('receipt not issued');
		const published = await keySet();
		expect(published.keys).toEqual([
			expect.objectContaining({ kty: 'OKP', crv: 'Ed25519', kid: 'test-1', alg: 'EdDSA' })
		]);
		expect(receiptKeySet(new Map([['test-1', SEED]]))).toEqual(published);

		const verified = await verifyReceipt(db, receipt.handle);
		if (!verified) throw new Error('receipt not found');
		expect(checkReceiptSignature(verified.statement, verified.signature, verified.signingKeyId, published)).toBe(
			'valid'
		);
		const forged = { ...(verified.statement as Record<string, unknown>), asserts: { resultGroup: 'winner' } };
		expect(checkReceiptSignature(forged, verified.signature, verified.signingKeyId, published)).toBe('invalid');
		expect(checkReceiptSignature(verified.statement, verified.signature, 'retired-9', published)).toBe('unknown_key');
	});
});

describe('receipts on the catalog card', () => {
	const view = (
		candidateId: string,
		companyId: string,
		extras: ('fsp_achievements_exact' | 'external_profiles')[] = []
	) =>
		loadCatalogCard(database.db, {
			candidateId,
			companyId,
			pseudonym: 'k7q2x4m5n6p7r2s3t4v5w6x7yz',
			extras,
			now: new Date(),
			signer
		});

	it('issues the receipts of the facts the card shows when a company opens it, once per fact version', async () => {
		const { db } = database;
		const { candidate, fact } = await candidateWithResult();
		const company = await createCompany(db);
		expect(await receiptsOf(fact.id, company.id)).toHaveLength(0);

		const first = await view(candidate.id, company.id);
		expect(first.receipts).toEqual([
			expect.objectContaining({
				level: 'generalized',
				status: 'valid',
				verifiedAt: '2026-09-20'
			})
		]);
		expect(first.receipts[0]?.asserts).toMatchObject({ discipline: 'algorithmic', season: 2025 });
		expect(first.receipts[0]?.doesNotAssert).toContain('личный вклад в командное решение');
		const [issued] = await receiptsOf(fact.id, company.id);
		expect(first.card.receipts).toEqual([{ level: 'generalized', handle: issued?.handle }]);
		expect(first.card.fspAchievements?.map((achievement) => achievement.receiptHandles)).toEqual([[issued?.handle]]);
		expect(JSON.stringify(first)).not.toContain(fact.id);
		// The public check finds the very receipt the card shows.
		expect((await verifyReceipt(db, first.receipts[0]?.handle ?? ''))?.status).toBe('valid');

		const again = await view(candidate.id, company.id);
		expect(again.receipts.map((receipt) => receipt.handle)).toEqual([issued?.handle]);
		expect(await receiptsOf(fact.id, company.id)).toHaveLength(1);

		// A new version of the record: the old receipt is superseded, the card gets a receipt of the new one.
		await db.update(sourceFacts).set({ payloadSha256: randomSha256() }).where(eq(sourceFacts.id, fact.id));
		const updated = await view(candidate.id, company.id);
		expect(updated.receipts.map((receipt) => [receipt.handle === issued?.handle, receipt.status]).sort()).toEqual([
			[false, 'valid'],
			[true, 'superseded']
		]);
	});

	it('shows an achievement with the receipt of the level it is shown at, never both', async () => {
		const { db } = database;
		const { candidate, fact } = await candidateWithResult();
		const company = await createCompany(db);
		// The company saw the card generalized first, then the candidate disclosed the exact achievements: the card
		// shows the achievement with its exact receipt alone, not the generalized one beside it.
		const before = await view(candidate.id, company.id);
		expect(before.receipts.map((receipt) => receipt.level)).toEqual(['generalized']);
		const card = await view(candidate.id, company.id, ['fsp_achievements_exact']);
		expect(card.receipts.map((receipt) => receipt.level)).toEqual(['exact']);
		expect(card.receipts[0]?.asserts).toMatchObject({ place: 2 });
		expect(card.card.fspAchievements?.map((achievement) => achievement.receiptHandles)).toEqual([
			[card.receipts[0]?.handle]
		]);

		// Another company that sees the card generalized gets only a generalized receipt of its own.
		const other = await createCompany(db);
		const generalized = await view(candidate.id, other.id);
		expect(generalized.receipts.map((receipt) => receipt.level)).toEqual(['generalized']);
		expect((await receiptsOf(fact.id, other.id)).map((row) => row.disclosureLevel)).toEqual(['generalized']);
	});

	it('issues no receipt to a card of a candidate aged 14–17: it would assert more than the card shows', async () => {
		const { db } = database;
		const birth = new Date();
		birth.setUTCFullYear(birth.getUTCFullYear() - 16);
		const { candidate, fact } = await candidateWithResult({ birthDate: birth.toISOString().slice(0, 10) });
		const company = await createCompany(db);
		const card = await view(candidate.id, company.id, ['fsp_achievements_exact']);
		expect(card.card.isMinor).toBe(true);
		expect(card.card.fspAchievements).toHaveLength(1);
		expect(card.receipts).toEqual([]);
		expect(await receiptsOf(fact.id, company.id)).toHaveLength(0);
	});
});

describe('public receipt page', () => {
	it('shows what was verified, the status and the signature, and nothing about the person', async () => {
		const { db } = database;
		const { candidate, fact } = await candidateWithResult();
		const company = await createCompany(db);
		await issueCompanyReceipts(db, signer, templates, {
			companyId: company.id,
			candidateId: candidate.id,
			factIds: [fact.id],
			exactFactIds: []
		});
		const [receipt] = await receiptsOf(fact.id, company.id);
		if (!receipt) throw new Error('receipt not issued');

		const page = await openPage(receipt.handle);
		expect(page).toMatchObject({
			handle: receipt.handle,
			status: 'valid',
			level: 'generalized',
			signature: 'valid',
			statement: {
				source: 'fsp',
				verifiedAt: '2026-09-20',
				asserts: { discipline: 'algorithmic', competitionLevel: 'russian_championship', season: 2025 }
			}
		});
		const text = JSON.stringify(page);
		expect(text).toContain('личный вклад в командное решение');
		for (const personal of [candidate.id, candidate.userId, company.id, TEAM_NAME, fact.sourceRecordRef, fact.id]) {
			expect(text).not.toContain(personal);
		}

		await db.update(sourceFacts).set({ status: 'withdrawn' }).where(eq(sourceFacts.id, fact.id));
		expect((await openPage(receipt.handle))?.status).toBe('not_valid');
	});

	it('answers an unknown handle with 404', async () => {
		await expect(openPage('a'.repeat(26))).rejects.toMatchObject({ status: 404 });
		await expect(openPage('not-a-handle')).rejects.toMatchObject({ status: 404 });
	});
});
