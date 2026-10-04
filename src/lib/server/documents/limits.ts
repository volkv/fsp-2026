// Upload limits of documents. Imported by relative path from the schema (files_resume_size check).
import { ApiError } from '../errors/api-error';

/** Largest resume the parsing service accepts: 10 MiB (docs/contracts.md, section 4.3). */
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;

/** Rejects a resume larger than the parser limit before it is stored or sent to the parser. */
export function assertResumeSize(sizeBytes: number): void {
	if (sizeBytes > RESUME_MAX_BYTES) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'file', code: 'too_large', message: 'Файл больше 10 МиБ: загрузите файл меньшего размера' }]
		});
	}
}
