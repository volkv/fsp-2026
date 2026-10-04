// The quality panel shows concrete evaluation runs: the latest by default or the one asked for, metrics against the
// thresholds and the baseline written with the run, and a run in another format is named as such, not drawn. The runs
// here are the committed reports of the evaluation harness (tools/eval/reports): the keys and numbers of real runs.
// `record` of the harness's bridge stores a run with its report file, which the administrator then downloads.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import QualityPanel from '$lib/components/admin/quality-panel.svelte';
import type { AccessSubject } from '$lib/server/access/permissions';
import { qualityPanel } from '$lib/server/admin/quality';
import { evalRuns, files, staffRoles } from '$lib/server/db/schema';
import { openFile } from '$lib/server/storage/access';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { recordRun, runRowSchema, type RunRow } from '../../src/eval/record';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createUser } from '../helpers/factories';

const REPORT = new URL('../../tools/eval/reports/synthetic-resumes-v2-dev-rules_only.json', import.meta.url);

let database: TestDatabase;
let adminId: string;
let row: RunRow;
const meta = { requestId: 'req-quality', ip: null, userAgent: null };
const ADMIN_EMAIL = 'quality-admin@example.com';
const crypto = { lookupHmac: (_purpose: string, value: string) => `hmac:${value}` };

const subject = (staff: Partial<AccessSubject['staff']>, userId = adminId): AccessSubject => ({
	userId,
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: false, admin: false, extraPermissions: [], ...staff }
});
const admin = () => ({ subject: subject({ admin: true }), meta });

class MemoryStore implements ObjectStore {
	readonly objects = new Map<string, Uint8Array>();
	put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
		this.objects.set(key, bytes);
		return Promise.resolve();
	}
	get(key: string): Promise<StoredObject | null> {
		const bytes = this.objects.get(key);
		if (!bytes) return Promise.resolve(null);
		return Promise.resolve({
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				}
			}),
			sizeBytes: bytes.byteLength,
			contentType: 'application/json'
		});
	}
	delete(key: string): Promise<void> {
		this.objects.delete(key);
		return Promise.resolve();
	}
	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.objects.has(key));
	}
}

const insertRun = (createdAt: Date, overrides: Partial<typeof evalRuns.$inferInsert> = {}) => ({
	productRevision: 'abc123',
	datasetId: row.dataset_id,
	datasetSize: row.dataset_size,
	datasetProvenance: row.dataset_provenance,
	split: row.split,
	versions: row.versions,
	processingMode: row.processing_mode,
	thresholds: row.thresholds,
	metrics: row.metrics,
	createdAt,
	...overrides
});

beforeAll(async () => {
	row = runRowSchema.parse((JSON.parse(await readFile(REPORT, 'utf8')) as { row: unknown }).row);
	database = await createTestDatabase();
	adminId = (await createUser(database.db, { emailHmac: crypto.lookupHmac('email', ADMIN_EMAIL) })).id;
	await database.db.insert(staffRoles).values({ userId: adminId, role: 'admin', grantedAt: new Date() });
});

afterAll(async () => {
	await database.drop();
});

describe('quality panel', () => {
	it('says there is no run instead of drawing numbers', async () => {
		expect(await qualityPanel(database.db, admin())).toEqual({ run: null, history: [], total: 0 });
	});

	it('shows a recorded run of the harness: every threshold judged, the baselines and the report file', async () => {
		const store = new MemoryStore();
		const reportPath = join(await mkdtemp(join(tmpdir(), 'eval-report-')), 'report.json');
		await writeFile(reportPath, JSON.stringify({ row }));
		const recorded = await recordRun(
			{ db: database.db, store, crypto },
			row,
			{ path: reportPath, name: 'eval-dev.json', owner_email: ADMIN_EMAIL },
			'abc123'
		);

		const panel = await qualityPanel(database.db, admin());
		expect(panel.run).toMatchObject({
			id: recorded.id,
			datasetId: 'synthetic-resumes-v2',
			formatProblem: null,
			report: { fileId: recorded.report.file_id, name: 'eval-dev.json', status: 'ready' }
		});
		const metrics = panel.run?.groups?.flatMap((group) => group.metrics) ?? [];
		expect(metrics.map((metric) => metric.key).sort()).toEqual(Object.keys(row.metrics).sort());
		for (const metric of metrics) {
			const limit = row.thresholds[metric.key];
			const value = row.metrics[metric.key]?.value ?? null;
			if (!limit) expect(metric.status, metric.key).toBe(value === null ? 'no_value' : 'no_threshold');
			else {
				const inside = value !== null && value >= (limit.min ?? -Infinity) && value <= (limit.max ?? Infinity);
				expect(metric.status, metric.key).toBe(value === null ? 'missing' : inside ? 'pass' : 'fail');
			}
		}
		expect(recorded.failed.sort()).toEqual(
			metrics
				.filter((m) => m.status === 'fail' || m.status === 'missing')
				.map((m) => m.key)
				.sort()
		);
		const ndcg = metrics.find((metric) => metric.key === 'matching.ndcg_at_10');
		expect(ndcg?.baseline).toBe(row.metrics['matching.ndcg_at_10.keywords']?.value);
		expect(panel.run?.groups?.map((group) => group.key)).toEqual([
			'resume',
			'skills',
			'categorization',
			'matching',
			'performance'
		]);

		// The report link of the panel: the administrator downloads the very file the harness wrote.
		const download = await openFile(
			{ db: database.db, store, now: () => new Date() },
			subject({ admin: true }),
			recorded.report.file_id,
			{ kind: 'eval_report', runId: recorded.id },
			meta
		);
		expect(await new Response(download.body).text()).toBe(await readFile(reportPath, 'utf8'));
		expect(download).toMatchObject({ contentType: 'application/json', declaredName: 'eval-dev.json' });
		const [stored] = await database.db.select().from(files).where(eq(files.id, recorded.report.file_id));
		expect(stored).toMatchObject({ purpose: 'export', ownerUserId: adminId, sha256: recorded.report.sha256 });
	});

	it('counts a threshold the run could not compute as failed, and reads any run by id', async () => {
		const missing = {
			...row.metrics,
			'matching.ndcg_at_10': { value: null, n: 0, baseline: row.metrics['matching.ndcg_at_10']?.baseline ?? null }
		};
		const [older] = await database.db
			.insert(evalRuns)
			.values(insertRun(new Date(Date.now() - 86_400_000), { metrics: { f1: 0.8 } }))
			.returning();
		const [latest] = await database.db
			.insert(evalRuns)
			.values(insertRun(new Date(), { metrics: missing }))
			.returning();
		const panel = await qualityPanel(database.db, admin());
		expect(panel.run?.id).toBe(latest?.id);
		const metrics = panel.run?.groups?.flatMap((group) => group.metrics) ?? [];
		expect(metrics.find((metric) => metric.key === 'matching.ndcg_at_10')?.status).toBe('missing');
		const matching = panel.run?.groups?.find((group) => group.key === 'matching');
		expect(matching?.failed).toBe(
			matching?.metrics.filter((m) => m.status === 'fail' || m.status === 'missing').length
		);
		expect(matching?.failed).toBeGreaterThan(0);
		expect(panel.run?.report).toBeNull();

		const previous = await qualityPanel(database.db, admin(), older?.id ?? '');
		expect(previous.run).toMatchObject({ id: older?.id, groups: null });
		expect(previous.run?.formatProblem).toContain('metrics');
		expect(previous.history.find((item) => item.id === older?.id)?.failed).toBeNull();
	});

	it('records a run only for an administrator and leaves no report object behind a failed record', async () => {
		const store = new MemoryStore();
		const reportPath = join(await mkdtemp(join(tmpdir(), 'eval-report-')), 'report.json');
		await writeFile(reportPath, '{}');
		// An account that is not an administrator.
		await createUser(database.db, { emailHmac: crypto.lookupHmac('email', 'someone@example.com') });
		await expect(
			recordRun(
				{ db: database.db, store, crypto },
				row,
				{ path: reportPath, name: 'r.json', owner_email: 'someone@example.com' },
				'abc123'
			)
		).rejects.toThrow('no active administrator');
		// A row the database refuses: the object written before it is removed.
		await expect(
			recordRun(
				{ db: database.db, store, crypto },
				{ ...row, dataset_size: -1 },
				{ path: reportPath, name: 'r.json', owner_email: ADMIN_EMAIL },
				'abc123'
			)
		).rejects.toThrow();
		expect(store.objects.size).toBe(0);
	});

	it('names the part of the dataset the run measured: a dev run is not passed off as the holdout', async () => {
		const [dev] = await database.db
			.insert(evalRuns)
			.values(insertRun(new Date(Date.now() + 60_000)))
			.returning();
		const [holdout] = await database.db
			.insert(evalRuns)
			.values(insertRun(new Date(Date.now() - 60_000), { split: 'holdout-by-profile-and-family' }))
			.returning();
		const page = async (id?: string) => {
			const { body } = render(QualityPanel, {
				props: { panel: await qualityPanel(database.db, admin(), id), latest: !id }
			});
			return body.replace(/<!--[^]*?-->/g, '');
		};
		expect(row.split).toBe('dev-by-profile-and-family');
		const onDev = await page();
		expect(onDev).toContain(`data-eval-run="${dev?.id}"`);
		expect(onDev).toContain('Цифры конкретного прогона оценки на рабочей части выборки (dev)');
		expect(onDev).not.toContain('отложенной');
		const onHoldout = await page(holdout?.id);
		expect(onHoldout).toContain('Цифры конкретного прогона оценки на отложенной части выборки (holdout)');
		expect(onHoldout).toContain('рабочая часть (dev)');
	});

	it('is closed to anyone but an administrator', async () => {
		await expect(
			qualityPanel(database.db, { subject: subject({ operator: true, extraPermissions: ['audit.read'] }), meta })
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});
