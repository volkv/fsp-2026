// Stored files (docs/domain.md, section 15.1): an upload is checked by content, hashed and put into the bucket under a
// key without personal data, then recorded in `files` in the transaction of the change that needs it. The object is
// written before the row: a failed transaction leaves an object the caller removes, never a row without its object.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { files } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import type { ObjectStore } from './object-store';
import { detectFormat, FORMAT_MIME, type DocumentFormat } from './signature';

export type FilePurpose = (typeof files.$inferInsert)['purpose'];

/** Longest original file name kept for the owner; the name is shown only to them. */
const MAX_DECLARED_NAME = 255;

export interface PreparedUpload {
	fileId: string;
	storageKey: string;
	purpose: FilePurpose;
	sha256: string;
	sizeBytes: number;
	format: DocumentFormat;
	detectedMime: string;
	declaredName: string;
	bytes: Uint8Array<ArrayBuffer>;
}

function invalid(code: string, message: string): ApiError {
	return new ApiError('validation_failed', { details: [{ path: 'file', code, message }] });
}

/** The declared name without directories and control characters; an empty one becomes «file». */
export function cleanName(declaredName: string): string {
	const base = declaredName.split(/[\\/]/u).at(-1) ?? '';
	// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
	const printable = base.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
	const name = Array.from(printable).slice(0, MAX_DECLARED_NAME).join('');
	return name.length > 0 ? name : 'file';
}

/**
 * Checks an upload: not empty and in a format of the purpose by its signature. The size limit of the purpose is checked
 * by the caller before (`documents/limits.ts`). Throws `validation_failed` with a message the user can act on.
 */
export function prepareUpload(input: {
	purpose: FilePurpose;
	bytes: Uint8Array<ArrayBuffer>;
	declaredName: string;
	/** Formats accepted for this purpose. */
	formats: readonly DocumentFormat[];
}): PreparedUpload {
	const { bytes } = input;
	if (bytes.byteLength === 0) throw invalid('empty', 'Файл пустой: выберите другой файл');
	const format = detectFormat(bytes);
	if (format === null || !input.formats.includes(format)) {
		throw invalid('unsupported_format', 'Формат не поддерживается: загрузите PDF или DOCX');
	}
	const fileId = uuidv7();
	return {
		fileId,
		storageKey: `${input.purpose}/${fileId}`,
		purpose: input.purpose,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		sizeBytes: bytes.byteLength,
		format,
		detectedMime: FORMAT_MIME[format],
		declaredName: cleanName(input.declaredName),
		bytes
	};
}

/** Puts the object of a prepared upload into the bucket. */
export async function putUpload(store: ObjectStore, upload: PreparedUpload): Promise<void> {
	await store.put(upload.storageKey, upload.bytes, upload.detectedMime);
}

/** Records the stored object; called in the transaction of the change that uses the file. */
export async function insertFile(executor: Executor, upload: PreparedUpload, ownerUserId: string): Promise<void> {
	await executor.insert(files).values({
		id: upload.fileId,
		ownerUserId,
		purpose: upload.purpose,
		storageKey: upload.storageKey,
		sha256: upload.sha256,
		sizeBytes: upload.sizeBytes,
		declaredName: upload.declaredName,
		detectedMime: upload.detectedMime,
		status: 'uploaded'
	});
}

/**
 * Removes the object of an upload whose transaction failed, then rethrows the original error. A failure to remove is
 * reported together with it: the orphan object must be visible, not forgotten.
 */
export async function discardUpload(store: ObjectStore, upload: PreparedUpload, cause: unknown): Promise<never> {
	try {
		await store.delete(upload.storageKey);
	} catch (cleanup) {
		throw new AggregateError([cause, cleanup], `upload ${upload.fileId} failed and its object was not removed`, {
			cause: cleanup
		});
	}
	throw cause;
}

export type FileRow = typeof files.$inferSelect;

export async function fileById(executor: Executor, fileId: string): Promise<FileRow | null> {
	const [row] = await executor.select().from(files).where(eq(files.id, fileId));
	return row ?? null;
}
