// A batch of FSP results loaded by the operator (docs/contracts.md 1.7): the preview reads and checks the file without
// writing anything and tells where its rows would go; the import takes only the batch that was previewed, keeps the
// source file as `source_batch` and records `fsp.batch_imported` with the counts, which is the history of loads.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	athleteLinks,
	auditEvents,
	consentEvents,
	externalIdentities,
	files,
	jobs,
	sourceFacts
} from '$lib/server/db/schema';
import type { Docparse } from '$lib/server/documents/docparse';
import { ApiError } from '$lib/server/errors/api-error';
import { batchHistory, importBatch, previewBatch, type BatchDeps } from '$lib/server/fsp/import/batches';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { createRetentionSweepHandler } from '$lib/server/jobs/retention';
import type { RequestMeta } from '$lib/server/auth/context';
import { S3ObjectStore, type ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createPublishedDocument, createUser } from '../helpers/factories';
import { startStorage } from '../helpers/storage';

const FIXTURES = fileURLToPath(new URL('../fixtures/fsp-import', import.meta.url));
const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const POLICIES_DIR = fileURLToPath(new URL('../../policies', import.meta.url));

let database: TestDatabase;
let storage: StartedTestContainer;
let deps: BatchDeps;
let store: ObjectStore;
let operator: AccessSubject;
let linkedCandidateId: string;
const meta: RequestMeta = { requestId: 'test-fsp-batches', ip: '127.0.0.1', userAgent: 'vitest' };

/** Exports are read without the parser; a call to it is a defect of the test. */
const noParser: Docparse = {
	parse: () => Promise.reject(new Error('an export is not sent to the parser'))
};

const fixture = (name: string) => readFileSync(`${FIXTURES}/${name}`);

function staff(userId: string, role: 'operator' | 'admin'): AccessSubject {
	return {
		userId,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: role === 'operator', admin: role === 'admin', extraPermissions: [] }
	};
}

function batchForm(input: {
	file: string;
	profile?: string;
	complete?: boolean;
	token?: string;
	allowRowIssues?: boolean;
}): FormData {
	const form = new FormData();
	form.append('file', new File([new Uint8Array(fixture(input.file))], input.file));
	form.append('profileText', input.profile ?? fixture('profile.json').toString('utf8'));
	if (input.complete) form.append('complete', 'on');
	if (input.token !== undefined) form.append('token', input.token);
	if (input.allowRowIssues) form.append('allowRowIssues', 'on');
	return form;
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	const error = await promise.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(error instanceof ApiError)) throw new Error(`expected a refusal, got ${String(error)}`);
	return error;
}

async function batchFiles() {
	return database.db.select().from(files).where(eq(files.purpose, 'source_batch'));
}

/** A candidate signed in with FSP ID `fspId`, linked and, unless told, under `fsp_import`. */
async function linkAthlete(fspId: string, consent = true): Promise<string> {
	const { db } = database;
	const candidate = await createCandidate(db, { birthDate: '2004-06-15' });
	const [identity] = await db
		.insert(externalIdentities)
		.values({
			userId: candidate.userId,
			issuer: 'http://fsp-id.test',
			subject: fspId,
			linkedAt: new Date(),
			linkMethod: 'signup_via_provider'
		})
		.returning();
	if (!identity) throw new Error('identity not inserted');
	await db.insert(athleteLinks).values({
		userId: candidate.userId,
		source: 'fsp',
		sourceAthleteId: fspId,
		basisIdentityId: identity.id,
		resolutionMethod: 'subject_equals_athlete_id',
		status: 'active',
		linkedAt: new Date()
	});
	if (consent) {
		const document = await createPublishedDocument(db, 'fsp_import');
		await db.insert(consentEvents).values({
			subjectCandidateId: candidate.id,
			kind: 'fsp_import',
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			method: 'separate_screen_button',
			evidence: { document_sha256: document.bodySha256 },
			occurredAt: new Date(Date.now() - 60_000)
		});
	}
	return candidate.id;
}

beforeAll(async () => {
	const [started, created] = await Promise.all([startStorage(), createTestDatabase()]);
	storage = started.container;
	database = created;
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
		// The retention policy as shipped: it states how long a batch file is kept.
		const policies = await readPolicyRelease(POLICIES_DIR);
		await publishPolicies(
			client,
			policies.filter((policy) => policy.kind === 'retention_policy')
		);
	} finally {
		await client.end({ timeout: 5 });
	}
	const signer = createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) });
	store = new S3ObjectStore(started.settings);
	deps = {
		db: database.db,
		store,
		parser: () => noParser,
		signer: () => signer,
		now: () => new Date()
	};
	operator = staff((await createUser(database.db, { displayName: 'Оператор Импорта' })).id, 'operator');
	linkedCandidateId = await linkAthlete('FSP-000101');
	await linkAthlete('FSP-000102', false);
}, 180_000);

afterAll(async () => {
	await database.drop();
	await storage.stop();
});

describe('preview', () => {
	it('reports the rows with issues and where the valid rows would go, writing nothing', async () => {
		const preview = await previewBatch(deps, { subject: operator, meta }, batchForm({ file: 'results-errors.csv' }));
		expect(preview).toMatchObject({
			fileName: 'results-errors.csv',
			format: 'csv',
			variant: 'file',
			profile: 'fsp-results-export',
			rowsRead: 7,
			rowsValid: 2,
			complete: false,
			incompleteReason: 'not_declared_complete',
			rows: { matched: 1, withoutFspId: 0, notLinked: 1, noConsent: 0 },
			athletes: 1,
			taxonomyMissing: false
		});
		expect(preview.issues.map(({ row, column, code }) => ({ row, column, code }))).toEqual([
			{ row: 3, column: 'Место', code: 'invalid_number' },
			{ row: 4, column: 'Дата начала', code: 'invalid_date' },
			{ row: 5, column: 'Статус результата', code: 'unknown_value' },
			{ row: 6, column: null, code: 'duplicate_result' },
			{ row: 7, column: 'ФСП ID', code: 'no_participant' }
		]);
		// The operator reads the reasons in their language, without the data of a person from the cells.
		expect(preview.issues[0]?.message).toBe('нужно целое число не меньше 1');
		for (const issue of preview.issues) expect(issue.message).not.toMatch(/Образцов|Примерова|Макетов|Пробный/);
		expect(await batchFiles()).toEqual([]);
		expect(await database.db.select().from(sourceFacts)).toEqual([]);
	});

	it('counts the rows of an athlete without the consent apart from those that reach no one', async () => {
		const preview = await previewBatch(
			deps,
			{ subject: operator, meta },
			batchForm({ file: 'results.csv', complete: true })
		);
		expect(preview.issues).toEqual([]);
		expect(preview).toMatchObject({ complete: true, rowsRead: 7, rowsValid: 7 });
		expect(preview.rows.matched).toBeGreaterThan(0);
		expect(preview.rows.noConsent).toBeGreaterThan(0);
		expect(preview.rows.notLinked).toBeGreaterThan(0);
		expect(preview.rows.matched + preview.rows.noConsent + preview.rows.notLinked + preview.rows.withoutFspId).toBe(7);
	});

	it('names every problem of a profile and a profile that does not fit the file', async () => {
		const broken = await refusal(
			previewBatch(
				deps,
				{ subject: operator, meta },
				batchForm({ file: 'results.csv', profile: JSON.stringify({ name: 'Bad Name', columns: { nope: 'X' } }) })
			)
		);
		expect(broken.code).toBe('validation_failed');
		expect(broken.details?.every((d) => d.path === 'profile' && d.code === 'profile_invalid')).toBe(true);
		// Each problem with its path, in the operator's language.
		for (const detail of broken.details ?? []) expect(detail.message).toMatch(/[а-я]/);
		expect(broken.details?.map((d) => d.message.split(':')[0])).toEqual(['name', 'columns']);

		const notJson = await refusal(
			previewBatch(deps, { subject: operator, meta }, batchForm({ file: 'results.csv', profile: '{ name' }))
		);
		expect(notJson.details).toEqual([expect.objectContaining({ path: 'profile', code: 'profile_not_json' })]);

		const mismatch = await refusal(
			previewBatch(
				deps,
				{ subject: operator, meta },
				batchForm({
					file: 'results.csv',
					profile: JSON.stringify({ name: 'other', columns: { fspId: 'Номер спортсмена' } })
				})
			)
		);
		expect(mismatch.details).toEqual([
			expect.objectContaining({
				path: 'profile',
				code: 'mapping_required',
				message: expect.stringContaining('Номер спортсмена') as unknown
			})
		]);
	});

	it('refuses a file beyond the limits of a results table before reading it', async () => {
		const form = batchForm({ file: 'results.csv' });
		const wide = `${fixture('results.csv').toString('utf8').split('\n')[0]}\n${';'.repeat(256)}\n`;
		form.set('file', new File([wide], 'wide.csv'));
		const refused = await refusal(previewBatch(deps, { subject: operator, meta }, form));
		expect(refused.code).toBe('validation_failed');
		expect(refused.details).toEqual([
			expect.objectContaining({
				path: 'file',
				code: 'limit_exceeded',
				message: expect.stringContaining('больше 256 колонок') as unknown
			})
		]);
		expect(await batchFiles()).toEqual([]);
	});

	it('is closed to anyone without the import right', async () => {
		const admin = staff((await createUser(database.db)).id, 'admin');
		const refused = await refusal(previewBatch(deps, { subject: admin, meta }, batchForm({ file: 'results.csv' })));
		expect(refused.code).toBe('forbidden');
		expect((await refusal(batchHistory(database.db, admin))).code).toBe('forbidden');
	});
});

describe('import', () => {
	it('refuses a batch that differs from the previewed one and a batch with issues not confirmed', async () => {
		const preview = await previewBatch(deps, { subject: operator, meta }, batchForm({ file: 'results.csv' }));
		// The completeness statement changed after the preview.
		const stale = await refusal(
			importBatch(
				deps,
				{ subject: operator, meta },
				batchForm({ file: 'results.csv', complete: true, token: preview.token })
			)
		);
		expect(stale.code).toBe('conflict');

		const withIssues = await previewBatch(deps, { subject: operator, meta }, batchForm({ file: 'results-errors.csv' }));
		const unconfirmed = await refusal(
			importBatch(deps, { subject: operator, meta }, batchForm({ file: 'results-errors.csv', token: withIssues.token }))
		);
		expect(unconfirmed.details).toEqual([expect.objectContaining({ path: 'allowRowIssues', code: 'row_issues' })]);
		expect(await batchFiles()).toEqual([]);
		expect(await database.db.select().from(sourceFacts)).toEqual([]);
	});

	it('imports the previewed batch, keeps its file and records the load with its counts', async () => {
		const form = () => batchForm({ file: 'results.csv', complete: true });
		const preview = await previewBatch(deps, { subject: operator, meta }, form());
		const withToken = form();
		withToken.append('token', preview.token);
		const imported = await importBatch(deps, { subject: operator, meta }, withToken);
		if (!imported.ok) throw new Error(imported.message);
		expect(imported.summary.rows).toEqual(preview.rows);
		expect(imported.summary.facts.inserted).toBe(preview.rows.matched);

		const [file] = await batchFiles();
		// Kept for `fsp_batch_retention_days` of the shipped retention policy from the day of the upload.
		const keptUntil = new Date();
		keptUntil.setUTCDate(keptUntil.getUTCDate() + 90);
		expect(file).toMatchObject({
			id: imported.fileId,
			ownerUserId: operator.userId,
			status: 'ready',
			declaredName: 'results.csv',
			detectedMime: 'text/csv',
			sizeBytes: fixture('results.csv').byteLength,
			retentionUntil: keptUntil.toISOString().slice(0, 10)
		});
		const facts = await database.db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, linkedCandidateId));
		expect(facts.length).toBe(preview.rows.matched);
		expect(new Set(facts.map((f) => f.sourceSnapshotSha256))).toEqual(new Set([file?.sha256]));

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'fsp.batch_imported'), eq(auditEvents.objectId, imported.fileId)));
		expect(event).toMatchObject({
			outcome: 'success',
			actorUserId: operator.userId,
			objectType: 'file',
			subjectCandidateId: null,
			details: {
				file_id: imported.fileId,
				format: 'csv',
				complete: true,
				rows_read: 7,
				row_issues: 0,
				rows: {
					matched: preview.rows.matched,
					without_fsp_id: preview.rows.withoutFspId,
					not_linked: preview.rows.notLinked,
					no_consent: preview.rows.noConsent
				},
				facts: expect.objectContaining({ inserted: preview.rows.matched }) as unknown
			}
		});

		const [latest] = await batchHistory(database.db, operator);
		expect(latest).toEqual({
			eventId: event?.id,
			at: event?.occurredAt.toISOString(),
			operatorName: 'Оператор Импорта',
			file: { id: imported.fileId, name: 'results.csv', available: true },
			result: {
				kind: 'imported',
				variant: 'file',
				format: 'csv',
				profile: 'fsp-results-export',
				complete: true,
				incompleteReason: null,
				rowsRead: 7,
				rowIssues: 0,
				matched: preview.rows.matched,
				athletes: 1,
				inserted: preview.rows.matched,
				removed: 0
			}
		});
	});

	it('imports only the valid rows of a batch with issues when the operator confirms it', async () => {
		const preview = await previewBatch(deps, { subject: operator, meta }, batchForm({ file: 'results-errors.csv' }));
		const imported = await importBatch(
			deps,
			{ subject: operator, meta },
			batchForm({ file: 'results-errors.csv', token: preview.token, allowRowIssues: true })
		);
		if (!imported.ok) throw new Error(imported.message);
		expect(imported.summary).toMatchObject({ rowIssues: 5, complete: false, facts: { inserted: 0, unchanged: 1 } });
		const history = await batchHistory(database.db, operator);
		expect(history.map((h) => h.file?.name)).toEqual(['results-errors.csv', 'results.csv']);
		expect(history[0]?.result).toMatchObject({
			kind: 'imported',
			rowIssues: 5,
			complete: false,
			incompleteReason: 'not_declared_complete'
		});
	});
});

describe('retention of batch files', () => {
	it('removes the object and the row of a batch file past its retention, and only of it', async () => {
		const { db } = database;
		const [expired, kept] = await batchFiles();
		if (!expired || !kept) throw new Error('two batch files are expected from the imports above');
		await db.update(files).set({ retentionUntil: '2026-01-01' }).where(eq(files.id, expired.id));
		expect(await store.exists(expired.storageKey)).toBe(true);

		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'retention.sweep',
				{ date: '2026-10-09' },
				{ inputVersion: '2026-10-09', createdBy: { kind: 'system' } }
			)
		);
		const claimed = (await claimJob(db, 'retention-test', ['retention.sweep'])) as ClaimedJob<'retention.sweep'> | null;
		if (!claimed) throw new Error('the sweep is not due');
		const result = await createRetentionSweepHandler(() => ({ store })).run({
			job: claimed,
			db,
			signal: new AbortController().signal,
			requestId: `job:${claimed.id}`,
			log: createLogger({}, () => undefined)
		});
		expect(await completeJob(db, claimed, result)).toBe('succeeded');
		expect(result.describe?.()).toMatchObject({ batch_files_removed: 1 });

		expect(await store.exists(expired.storageKey)).toBe(false);
		expect(await db.select().from(files).where(eq(files.id, expired.id))).toEqual([]);
		expect(await store.exists(kept.storageKey)).toBe(true);
		expect(await db.select().from(files).where(eq(files.id, kept.id))).toHaveLength(1);
		// The history keeps the load and tells that its file is gone.
		const history = await batchHistory(db, operator);
		expect(history.map((entry) => entry.file?.id ?? null).sort()).toEqual([kept.id, null].sort());
		const [job] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, claimed.id));
		expect(job?.status).toBe('succeeded');
	});
});
