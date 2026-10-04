// Loading a batch of FSP results by the operator (docs/contracts.md 1.7): the file and the mapping profile are read and
// checked without writing anything (a preview with the row issues and how the rows reach people), then imported as
// previewed. The source file is kept in the storage as `source_batch` for `fsp_batch_retention_days` of the retention
// policy, then `retention.sweep` removes it; the journal event `fsp.batch_imported` carries its counts and is the
// history of loads. Nothing here names a person: the preview and the history are counts, codes
// and the row numbers of issues. A batch changes the facts of every visitor of the stand, so a demo account neither
// previews nor imports one, and the history shows the loads of the accounts within the reader's reach (domain 19.3).
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requireStandChange, StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { FSP_BATCH_IMPORTED_DETAILS } from '$lib/server/audit/events';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { auditActorOf, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database } from '$lib/server/db';
import { auditEvents, files, users } from '$lib/server/db/schema';
import type { Docparse } from '$lib/server/documents/docparse';
import { ApiError } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import { currentRetentionPolicy } from '$lib/server/jobs/retention';
import { canonicalJson } from '$lib/server/json/canonical';
import { cleanName } from '$lib/server/storage/files';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { FORMAT_MIME } from '$lib/server/storage/signature';
import type { ReceiptSigner } from '../receipts';
import { importResultsBatch, previewResultsBatch, type ImportSummary } from './apply';
import { feedFor, type ResultsBatch } from './feed';
import { parseProfile, type MappingProfile } from './profile';
import type { RowIssue } from './rows';

export interface BatchDeps {
	db: Database;
	store: ObjectStore;
	parser: () => Docparse;
	signer: () => ReceiptSigner;
	now: () => Date;
}

interface BatchContext {
	subject: AccessSubject;
	meta: RequestMeta;
}

/** The parser limit (contracts 4.3); an export is held to the same, and the request body limit is above it. */
const BATCH_MAX_BYTES = 10 * 1024 * 1024;
/** A mapping profile is a small JSON document. */
const PROFILE_MAX_BYTES = 256 * 1024;

const SHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What the form of a batch gives: the file, the profile and the operator's statement of completeness. */
interface BatchInput {
	bytes: Uint8Array<ArrayBuffer>;
	declaredName: string;
	profile: MappingProfile;
	/** The profile as the canonical JSON it was parsed from: part of what the preview stands for. */
	profileKey: string;
	declaredComplete: boolean;
}

interface BatchPreview {
	/** Stands for the file, the profile and the completeness statement previewed; the import is refused without it. */
	token: string;
	fileName: string;
	format: ResultsBatch['format'];
	variant: ResultsBatch['variant'];
	profile: string;
	complete: boolean;
	incompleteReason: string | null;
	ocrUsed: boolean;
	rowsRead: number;
	rowsValid: number;
	issues: RowIssue[];
	competitions: { id: string; title: string; startDate: string; ekpNumber: string | null }[];
	rows: { matched: number; withoutFspId: number; notLinked: number; noConsent: number };
	athletes: number;
	taxonomyMissing: boolean;
}

type ImportedBatch =
	| { ok: true; fileId: string; fileName: string; summary: ImportSummary }
	| { ok: false; fileId: string; refused: 'row_issues' | 'taxonomy_missing'; message: string };

const invalid = (path: string, code: string, message: string) =>
	new ApiError('validation_failed', { details: [{ path, code, message }] });

function fileOf(form: FormData, field: string): File | null {
	const value = form.get(field);
	return value instanceof File && value.size > 0 ? value : null;
}

/** The profile from its file or its pasted text, exactly one of them, parsed with every problem named. */
async function profileOf(form: FormData): Promise<{ profile: MappingProfile; key: string }> {
	const file = fileOf(form, 'profileFile');
	const pasted = form.get('profileText');
	const text = typeof pasted === 'string' ? pasted.trim() : '';
	if (file && text !== '') {
		throw invalid('profile', 'profile_ambiguous', 'Укажите профиль одним способом: файлом или текстом');
	}
	if (!file && text === '')
		throw invalid('profile', 'profile_required', 'Загрузите профиль сопоставления или вставьте его текст');
	if (file && file.size > PROFILE_MAX_BYTES) {
		throw invalid('profile', 'profile_too_large', 'Профиль больше 256 КиБ: это не профиль сопоставления');
	}
	const source = file ? await file.text() : text;
	let json: unknown;
	try {
		json = JSON.parse(source);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw invalid('profile', 'profile_not_json', `Профиль — не JSON: ${error.message}`);
	}
	const parsed = parseProfile(json);
	if (!parsed.ok) {
		throw new ApiError('validation_failed', {
			message: 'Профиль сопоставления не прошёл проверку',
			details: parsed.issues.map((message) => ({ path: 'profile', code: 'profile_invalid', message }))
		});
	}
	return { profile: parsed.profile, key: canonicalJson(json) };
}

async function readForm(form: FormData): Promise<BatchInput> {
	const file = fileOf(form, 'file');
	if (!file) throw invalid('file', 'file_required', 'Выберите файл пакета: CSV, XLSX, PDF, DOCX, ODT или RTF');
	if (file.size > BATCH_MAX_BYTES) throw invalid('file', 'too_large', 'Файл больше 10 МиБ: разделите пакет на части');
	const { profile, key } = await profileOf(form);
	return {
		bytes: new Uint8Array(await file.arrayBuffer()),
		declaredName: cleanName(file.name),
		profile,
		profileKey: key,
		declaredComplete: form.get('complete') === 'on'
	};
}

const sha256Of = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

function tokenOf(input: BatchInput): string {
	return sha256Of(`${sha256Of(input.bytes)}|${sha256Of(input.profileKey)}|${input.declaredComplete ? 1 : 0}`);
}

/** Why a file could not be read as a batch, told to the operator next to the field it concerns. */
function readFailure(code: string, retryable: boolean, message: string): ApiError {
	switch (code) {
		case 'unavailable':
			return new ApiError('degraded', {
				message: retryable
					? 'Сервис разбора документов недоступен: повторите через минуту'
					: 'Сервис разбора документов не смог прочитать протокол'
			});
		case 'mapping_required':
			return invalid('profile', code, `Профиль не подходит к файлу: ${message}`);
		case 'protocol_error':
			return invalid('file', code, `Протокол не удалось разобрать: ${message}`);
		default:
			return invalid('file', code, `Файл не читается как пакет результатов: ${message}`);
	}
}

async function readBatch(deps: BatchDeps, input: BatchInput, requestId: string): Promise<ResultsBatch> {
	const read = await feedFor(input.bytes, deps.parser).readBatch({
		bytes: input.bytes,
		declaredName: input.declaredName,
		profile: input.profile,
		declaredComplete: input.declaredComplete,
		requestId
	});
	if (!read.ok) throw readFailure(read.error.code, read.error.retryable, read.error.message);
	return read.value;
}

/** Reads and checks a batch and tells what its import would do; nothing is stored. */
export async function previewBatch(deps: BatchDeps, context: BatchContext, form: FormData): Promise<BatchPreview> {
	requirePermission(context.subject, 'fsp.import', null);
	await requireStandChange(deps.db, context.subject);
	const input = await readForm(form);
	const batch = await readBatch(deps, input, context.meta.requestId);
	const preview = await previewResultsBatch(deps.db, batch);
	return {
		token: tokenOf(input),
		fileName: input.declaredName,
		format: batch.format,
		variant: batch.variant,
		profile: batch.profile,
		complete: batch.completeness.complete,
		incompleteReason: batch.completeness.incompleteReason ?? null,
		ocrUsed: batch.ocrUsed,
		rowsRead: batch.rowsRead,
		rowsValid: batch.rows.length,
		issues: batch.issues,
		competitions: batch.competitions.map((c) => ({
			id: c.id,
			title: c.title,
			startDate: c.startDate,
			ekpNumber: c.ekpNumber
		})),
		rows: preview.rows,
		athletes: preview.athletes,
		taxonomyMissing: preview.taxonomyMissing
	};
}

/**
 * The day after which the source file of a batch uploaded at `at` is removed, by the retention policy in effect. A
 * policy without the term is a deployment defect (the policies are published with the seed): no file is kept unbounded.
 */
async function batchRetentionUntil(executor: Database, at: Date): Promise<string> {
	const policy = await currentRetentionPolicy(executor);
	if (!policy || !('fsp_batch_retention_days' in policy)) {
		throw new Error('the retention_policy in effect states no retention of batch files (version 3 and later)');
	}
	const day = new Date(at);
	day.setUTCDate(day.getUTCDate() + policy.fsp_batch_retention_days);
	return day.toISOString().slice(0, 10);
}

function mimeOf(format: ResultsBatch['format']): string {
	if (format === 'csv') return 'text/csv';
	if (format === 'xlsx') return SHEET_MIME;
	return FORMAT_MIME[format];
}

/**
 * Imports the batch the operator previewed: the same file, profile and completeness statement, or a refusal to look
 * again. The source file is stored before any fact changes, so every imported fact has its file; the file becomes
 * `ready` with the journal event of the import, or `rejected` when the import refuses the batch.
 */
export async function importBatch(deps: BatchDeps, context: BatchContext, form: FormData): Promise<ImportedBatch> {
	const { subject, meta } = context;
	requirePermission(subject, 'fsp.import', null);
	await requireStandChange(deps.db, subject);
	const userId = sessionUserId(subject);
	const input = await readForm(form);
	if (form.get('token') !== tokenOf(input)) {
		throw new ApiError('conflict', {
			message: 'Файл, профиль или отметка полноты изменились после предпросмотра: проверьте пакет ещё раз',
			details: [{ path: 'token', code: 'preview_stale', message: 'Проверьте пакет ещё раз перед загрузкой' }]
		});
	}
	const allowRowIssues = form.get('allowRowIssues') === 'on';
	const batch = await readBatch(deps, input, meta.requestId);
	if (batch.issues.length > 0 && !allowRowIssues) {
		throw invalid(
			'allowRowIssues',
			'row_issues',
			'В пакете строки с ошибками: исправьте файл или отметьте, что загружаете только верные строки'
		);
	}

	const retentionUntil = await batchRetentionUntil(deps.db, deps.now());
	const fileId = uuidv7();
	const storageKey = `source_batch/${fileId}`;
	const detectedMime = mimeOf(batch.format);
	await deps.store.put(storageKey, input.bytes, detectedMime);
	try {
		await deps.db.insert(files).values({
			id: fileId,
			ownerUserId: userId,
			purpose: 'source_batch',
			storageKey,
			sha256: batch.sha256,
			sizeBytes: input.bytes.byteLength,
			declaredName: input.declaredName,
			detectedMime,
			status: 'uploaded',
			retentionUntil
		});
	} catch (cause) {
		// The object without its row is removed; a failure to remove is reported with the cause, not forgotten.
		try {
			await deps.store.delete(storageKey);
		} catch (cleanup) {
			throw new AggregateError([cause, cleanup], `batch file ${fileId} was not recorded and its object stays`, {
				cause: cleanup
			});
		}
		throw cause;
	}

	// A failure of the import itself leaves the file `uploaded`: facts of the athletes done before it stay, each
	// athlete in its own transaction, and a repeated load of the same file completes the rest.

	const actor = auditActorOf(subject);
	const imported = await importResultsBatch(deps.db, batch, {
		actor,
		createdBy: { kind: 'user', id: userId },
		requestId: meta.requestId,
		signer: deps.signer(),
		allowRowIssues
	});
	const journal = {
		action: 'fsp.batch_imported' as const,
		actor,
		object: { type: 'file', id: fileId },
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		occurredAt: deps.now()
	};
	if (!imported.ok) {
		await deps.db.transaction(async (tx) => {
			await tx.update(files).set({ status: 'rejected' }).where(eq(files.id, fileId));
			await recordAuditEvent(tx, {
				...journal,
				outcome: 'failure',
				details: { file_id: fileId, refused: imported.code }
			});
		});
		return { ok: false, fileId, refused: imported.code, message: imported.message };
	}
	const { summary } = imported;
	await deps.db.transaction(async (tx) => {
		await tx.update(files).set({ status: 'ready' }).where(eq(files.id, fileId));
		await recordAuditEvent(tx, {
			...journal,
			outcome: 'success',
			details: {
				file_id: fileId,
				variant: summary.variant,
				format: batch.format,
				profile: summary.profile,
				complete: summary.complete,
				incomplete_reason: summary.incompleteReason,
				rows_read: summary.rowsRead,
				rows_valid: summary.rowsValid,
				row_issues: summary.rowIssues,
				competitions: summary.competitions,
				athletes: summary.athletes,
				rows: {
					matched: summary.rows.matched,
					without_fsp_id: summary.rows.withoutFspId,
					not_linked: summary.rows.notLinked,
					no_consent: summary.rows.noConsent
				},
				facts: {
					inserted: summary.facts.inserted,
					unchanged: summary.facts.unchanged,
					superseded: summary.facts.superseded,
					annulled: summary.facts.annulled,
					withdrawn: summary.facts.withdrawn,
					skipped_withdrawals: summary.facts.skippedWithdrawals,
					claims: summary.facts.claims,
					receipts: summary.facts.receipts
				}
			}
		});
	});
	return { ok: true, fileId, fileName: input.declaredName, summary };
}

interface BatchHistoryEntry {
	eventId: string;
	at: string;
	/** The operator's display name; `null` — the account has none. */
	operatorName: string | null;
	file: { id: string; name: string; available: boolean } | null;
	result:
		| {
				kind: 'imported';
				variant: ResultsBatch['variant'];
				format: ResultsBatch['format'];
				profile: string;
				complete: boolean;
				incompleteReason: string | null;
				rowsRead: number;
				rowIssues: number;
				matched: number;
				athletes: number;
				inserted: number;
				/** Facts that left the profiles: withdrawn or replaced by a new edition. */
				removed: number;
		  }
		| { kind: 'refused'; reason: 'row_issues' | 'taxonomy_missing' };
}

function historyResult(details: unknown): BatchHistoryEntry['result'] {
	const refused = FSP_BATCH_IMPORTED_DETAILS.refused.safeParse(details);
	if (refused.success) return { kind: 'refused', reason: refused.data.refused };
	const parsed = FSP_BATCH_IMPORTED_DETAILS.imported.parse(details);
	return {
		kind: 'imported',
		variant: parsed.variant,
		format: parsed.format,
		profile: parsed.profile,
		complete: parsed.complete,
		incompleteReason: parsed.incomplete_reason,
		rowsRead: parsed.rows_read,
		rowIssues: parsed.row_issues,
		matched: parsed.rows.matched,
		athletes: parsed.athletes,
		inserted: parsed.facts.inserted,
		removed: parsed.facts.withdrawn + parsed.facts.superseded
	};
}

/** Loads of batches from the journal, the latest first. */
export async function batchHistory(db: Database, subject: AccessSubject, limit = 50): Promise<BatchHistoryEntry[]> {
	requirePermission(subject, 'fsp.import', null);
	const rows = await db
		.select({
			id: auditEvents.id,
			at: auditEvents.occurredAt,
			details: auditEvents.details,
			operatorName: users.displayName,
			fileId: files.id,
			fileName: files.declaredName,
			fileStatus: files.status
		})
		.from(auditEvents)
		.leftJoin(users, eq(users.id, auditEvents.actorUserId))
		// The journal keeps object ids as text.
		.leftJoin(files, and(eq(auditEvents.objectType, 'file'), eq(sql`${files.id}::text`, auditEvents.objectId)))
		.where(
			and(
				eq(auditEvents.action, 'fsp.batch_imported'),
				(await StaffReach.of(db, subject)).user(auditEvents.actorUserId)
			)
		)
		.orderBy(desc(auditEvents.occurredAt))
		.limit(limit);
	return rows.map((row) => ({
		eventId: row.id,
		at: row.at.toISOString(),
		operatorName: row.operatorName,
		file:
			row.fileId === null || row.fileName === null
				? null
				: { id: row.fileId, name: row.fileName, available: row.fileStatus !== 'deleted' },
		result: historyResult(row.details)
	}));
}
