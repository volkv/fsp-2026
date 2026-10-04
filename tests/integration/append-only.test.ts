import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	auditEvents,
	consentEvents,
	embeddingSpaces,
	embeddings,
	legalDocuments,
	productPolicies,
	skills
} from '$lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import { createCandidate, createPolicy, createPublishedDocument, createTaxonomyVersion } from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

async function grantProcessingConsent() {
	const { db } = database;
	const candidate = await createCandidate(db);
	const document = await createPublishedDocument(db, 'pd_processing');
	const [event] = await db
		.insert(consentEvents)
		.values({
			subjectCandidateId: candidate.id,
			kind: 'pd_processing',
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			method: 'separate_screen_button',
			evidence: { ip: '127.0.0.1' },
			occurredAt: new Date()
		})
		.returning();
	if (!event) throw new Error('consent event not inserted');
	return { candidate, document, event };
}

describe('append-only tables', () => {
	it('reject UPDATE and DELETE of consent events', async () => {
		const { event } = await grantProcessingConsent();
		const { db } = database;
		await expectDbError(
			db.update(consentEvents).set({ reason: 'changed' }).where(eq(consentEvents.id, event.id)),
			SQLSTATE.restrictViolation,
			/append-only/
		);
		await expectDbError(db.delete(consentEvents).where(eq(consentEvents.id, event.id)), SQLSTATE.restrictViolation);
		await expectDbError(db.execute(sql`truncate consent_events cascade`), SQLSTATE.restrictViolation);
	});

	it('reject UPDATE and DELETE of the partitioned journal', async () => {
		const { db } = database;
		const [event] = await db
			.insert(auditEvents)
			.values({ action: 'auth.logout', outcome: 'success', actorKind: 'anonymous', requestId: 'r-1' })
			.returning();
		if (!event) throw new Error('audit event not inserted');
		await expectDbError(
			db.update(auditEvents).set({ requestId: 'r-2' }).where(eq(auditEvents.id, event.id)),
			SQLSTATE.restrictViolation
		);
		await expectDbError(db.delete(auditEvents).where(eq(auditEvents.id, event.id)), SQLSTATE.restrictViolation);
	});

	it('let only the retention role delete, and never update', async () => {
		const { event } = await grantProcessingConsent();
		const { db } = database;
		await expectDbError(
			db.transaction(async (tx) => {
				await tx.execute(sql`set local role fsp_retention`);
				await tx.update(consentEvents).set({ reason: 'x' }).where(eq(consentEvents.id, event.id));
			}),
			SQLSTATE.insufficientPrivilege
		);
		await db.transaction(async (tx) => {
			await tx.execute(sql`set local role fsp_retention`);
			await tx.delete(consentEvents).where(eq(consentEvents.id, event.id));
		});
		expect(await db.select().from(consentEvents).where(eq(consentEvents.id, event.id))).toEqual([]);
	});

	it('keep product policies immutable for everyone', async () => {
		const { db } = database;
		const policy = await createPolicy(db, 'invitation_policy', 7);
		await expectDbError(
			db.update(productPolicies).set({ params: {} }).where(eq(productPolicies.id, policy.id)),
			SQLSTATE.restrictViolation
		);
		await expectDbError(
			db.transaction(async (tx) => {
				await tx.execute(sql`set local role fsp_retention`);
				await tx.delete(productPolicies).where(eq(productPolicies.id, policy.id));
			}),
			SQLSTATE.insufficientPrivilege
		);
	});
});

describe('published reference data', () => {
	it('freezes a published legal document except its supersession mark', async () => {
		const { db } = database;
		const document = await createPublishedDocument(db, 'catalog_visibility');
		await expectDbError(
			db.update(legalDocuments).set({ body: 'другой текст' }).where(eq(legalDocuments.id, document.id)),
			SQLSTATE.restrictViolation
		);
		await db.update(legalDocuments).set({ supersededAt: new Date() }).where(eq(legalDocuments.id, document.id));
		await expectDbError(
			db.delete(legalDocuments).where(eq(legalDocuments.id, document.id)),
			SQLSTATE.restrictViolation
		);
	});

	it('freezes rows of a published taxonomy version', async () => {
		const { db } = database;
		const version = await createTaxonomyVersion(db);
		await db.insert(skills).values({ taxonomyVersionId: version.id, key: 'go', kind: 'language', name: 'Go' });
		await db.execute(
			sql`update taxonomy_versions set status = 'published', published_at = now() where id = ${version.id}`
		);
		await expectDbError(
			db.insert(skills).values({ taxonomyVersionId: version.id, key: 'rust', kind: 'language', name: 'Rust' }),
			SQLSTATE.restrictViolation
		);
		await expectDbError(
			db.update(skills).set({ name: 'Golang' }).where(eq(skills.key, 'go')),
			SQLSTATE.restrictViolation
		);
	});

	it('refuses a vector whose dimension differs from its space', async () => {
		const { db } = database;
		await db.insert(embeddingSpaces).values({
			id: 'test-space/3',
			modelName: 'test',
			modelRevision: 'r1',
			dimension: 3,
			queryPrefix: '',
			documentPrefix: '',
			pooling: 'mean',
			normalization: 'l2',
			maxInputTokens: 512,
			chunkingVersion: 'v1',
			status: 'building'
		});
		const base = {
			ownerType: 'skill' as const,
			ownerId: 'go',
			inputSha256: 'a'.repeat(64),
			inputVersion: '1',
			spaceId: 'test-space/3'
		};
		await db.insert(embeddings).values({ ...base, vector: [1, 0, 0] });
		await expectDbError(
			db.insert(embeddings).values({ ...base, ownerId: 'rust', vector: [1, 0] }),
			SQLSTATE.checkViolation,
			/dimensions/
		);
		await expectDbError(
			db.update(embeddingSpaces).set({ dimension: 4 }).where(eq(embeddingSpaces.id, 'test-space/3')),
			SQLSTATE.restrictViolation
		);
	});
});

describe('consent events', () => {
	it('refuse a written-form consent without a signature', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const document = await createPublishedDocument(db, 'automated_decision_written', { form: 'electronic_signature' });
		await expectDbError(
			db.insert(consentEvents).values({
				subjectCandidateId: candidate.id,
				kind: 'automated_decision_written',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: candidate.userId,
				method: 'separate_screen_button',
				evidence: { ip: '127.0.0.1' },
				occurredAt: new Date()
			}),
			SQLSTATE.checkViolation,
			/electronic signature/
		);
	});

	it('refuse a consent whose kind differs from its document', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const document = await createPublishedDocument(db, 'fsp_import');
		await expectDbError(
			db.insert(consentEvents).values({
				subjectCandidateId: candidate.id,
				kind: 'catalog_visibility',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: candidate.userId,
				method: 'separate_screen_button',
				evidence: {},
				occurredAt: new Date()
			}),
			SQLSTATE.checkViolation,
			/does not match/
		);
	});
});
