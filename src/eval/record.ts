// `record` of the bridge: one evaluation run becomes a row of `eval_runs` that the quality panel shows
// (src/lib/server/admin/quality.ts), with its report file. The row is checked against the panel's own schemas before
// the insert and read back through them after it, so a run the panel would call «another format» is refused instead of
// stored. The report goes into the storage as an `export` file of the administrator named by the harness and is linked
// to the row (`report_file_id`), which is what the panel's report link and the file access check read. The object is
// written before the rows; a failed transaction removes it.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { evaluateMetrics, runMetricsSchema, runThresholdsSchema } from '$lib/server/admin/quality';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database } from '$lib/server/db';
import { evalRuns, files, staffRoles, users } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import type { ObjectStore } from '$lib/server/storage/object-store';

export const runRowSchema = z
	.strictObject({
		dataset_id: z.string().min(1),
		dataset_size: z.int().nonnegative(),
		dataset_provenance: z.enum(['synthetic', 'manual_labeled', 'customer']),
		split: z.string().min(1),
		versions: z.record(z.string().min(1), z.union([z.string(), z.number(), z.record(z.string(), z.unknown())])),
		processing_mode: z.enum(['model', 'rules_only', 'partial', 'failed']),
		thresholds: runThresholdsSchema,
		metrics: runMetricsSchema
	})
	.superRefine((row, context) => {
		for (const key of Object.keys(row.thresholds)) {
			if (!(key in row.metrics)) {
				context.addIssue({
					code: 'custom',
					path: ['thresholds', key],
					message: 'a threshold of a metric the run has not'
				});
			}
		}
	});

export type RunRow = z.infer<typeof runRowSchema>;

export const reportFileSchema = z.strictObject({
	/** The report on the disk of the bridge process. */
	path: z.string().min(1),
	/** File name the download gets. */
	name: z.string().min(1).max(255),
	/** Address of an active administrator: the owner of the stored file. */
	owner_email: z.email().max(254)
});

export type ReportFile = z.infer<typeof reportFileSchema>;

export interface RecordDeps {
	db: Database;
	store: ObjectStore;
	crypto: Pick<FieldCrypto, 'lookupHmac'>;
}

export interface RecordedRun {
	id: string;
	metrics: number;
	/** Metrics outside their thresholds or not computed at one, as the panel counts them. */
	failed: string[];
	report: { file_id: string; size_bytes: number; sha256: string };
}

async function administrator(deps: RecordDeps, email: string): Promise<string> {
	const [owner] = await deps.db
		.select({ id: users.id })
		.from(users)
		.innerJoin(
			staffRoles,
			and(eq(staffRoles.userId, users.id), eq(staffRoles.role, 'admin'), isNull(staffRoles.revokedAt))
		)
		.where(and(eq(users.emailHmac, deps.crypto.lookupHmac('email', email)), eq(users.status, 'active')));
	if (!owner) throw new Error(`no active administrator has the address given for the report file`);
	return owner.id;
}

export async function recordRun(
	deps: RecordDeps,
	row: RunRow,
	report: ReportFile,
	productRevision: string
): Promise<RecordedRun> {
	const ownerUserId = await administrator(deps, report.owner_email);
	const bytes = new Uint8Array(await readFile(report.path));
	const fileId = uuidv7();
	const storageKey = `export/${fileId}`;
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	await deps.store.put(storageKey, bytes, 'application/json');
	let runId: string;
	try {
		runId = await deps.db.transaction(async (tx) => {
			await tx.insert(files).values({
				id: fileId,
				ownerUserId,
				purpose: 'export',
				storageKey,
				sha256,
				sizeBytes: bytes.byteLength,
				declaredName: report.name,
				detectedMime: 'application/json',
				status: 'ready'
			});
			const [inserted] = await tx
				.insert(evalRuns)
				.values({
					productRevision,
					datasetId: row.dataset_id,
					datasetSize: row.dataset_size,
					datasetProvenance: row.dataset_provenance,
					split: row.split,
					versions: row.versions,
					processingMode: row.processing_mode,
					thresholds: row.thresholds,
					metrics: row.metrics,
					reportFileId: fileId
				})
				.returning({ id: evalRuns.id });
			if (!inserted) throw new Error('eval_runs insert returned no row');
			return inserted.id;
		});
	} catch (cause) {
		try {
			await deps.store.delete(storageKey);
		} catch (cleanup) {
			throw new AggregateError([cause, cleanup], `run was not recorded and report object ${storageKey} remains`, {
				cause: cleanup
			});
		}
		throw cause;
	}
	const [stored] = await deps.db
		.select({ metrics: evalRuns.metrics, thresholds: evalRuns.thresholds })
		.from(evalRuns)
		.where(eq(evalRuns.id, runId));
	if (!stored) throw new Error(`eval run ${runId} is not readable after the insert`);
	const groups = evaluateMetrics(runMetricsSchema.parse(stored.metrics), runThresholdsSchema.parse(stored.thresholds));
	const rows = groups.flatMap((group) => group.metrics);
	return {
		id: runId,
		metrics: rows.length,
		failed: rows.filter((metric) => metric.status === 'fail' || metric.status === 'missing').map((m) => m.key),
		report: { file_id: fileId, size_bytes: bytes.byteLength, sha256 }
	};
}
