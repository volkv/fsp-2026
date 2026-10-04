// Job `resume.parse` (docs/domain.md, sections 15, 17.2; docs/contracts.md, section 4): reads the stored file, sends it
// to `docparse`, and writes the result conditionally — only while the document is still the candidate's current resume
// and still waits for its parse. A text becomes a `document_extractions` row and the extraction job is enqueued in the
// same transaction; a parser error becomes the resume status the contract names for it. Retryable errors go back to the
// queue while attempts remain; the last attempt records the failure instead of leaving the resume pending forever.
// Nothing is read or written without `pd_processing` in effect: the consent is checked before the file goes to the
// parser and again with the result. A resume whose ground of processing is gone (revoked or lapsed) fails with
// `no_processing_consent` instead of the result, so it is never left pending: after signing the consent again the
// candidate uploads the file anew.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { processingAllowed } from '$lib/server/consent/processing';
import type { Database, Transaction } from '$lib/server/db';
import { documentExtractions, files, resumeDocuments } from '$lib/server/db/schema';
import { docparse, type Docparse, type DocparseFailure, type ParseResponse } from '$lib/server/documents/docparse';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import type { LogFields } from '$lib/server/jobs/log';
import { enqueueJob } from '$lib/server/jobs/queue';
import { objectStore, readObject, StorageError, type ObjectStore } from '$lib/server/storage/object-store';
import type { ResumeParseError } from './parse-errors';
import { lockCandidate } from './revision';

export type ResumeParseStatus = (typeof resumeDocuments.$inferSelect)['parseStatus'];

/** The codes a run records; `unrecorded` belongs to resumes that failed before the code was kept. */
type RecordedFailure = Exclude<ResumeParseError, 'unrecorded'>;

/** The resume status a parse error leaves (section 4.4): an unknown format is told apart, the rest is `failed`. */
function statusOfFailure(code: ResumeParseError): ResumeParseStatus {
	return code === 'unsupported_format' ? 'unsupported_format' : 'failed';
}

/** `timeout` is repeated once (section 4.4); other retryable errors while the job has attempts. */
function mayRetry(failure: DocparseFailure, attempt: number, maxAttempts: number): boolean {
	if (!failure.retryable || attempt >= maxAttempts) return false;
	return failure.code !== 'timeout' || attempt < 2;
}

interface Target {
	resumeDocumentId: string;
	candidateId: string;
	fileId: string;
	storageKey: string;
	sha256: string;
	declaredName: string;
}

async function loadTarget(db: Database, resumeDocumentId: string): Promise<Target | null> {
	const [row] = await db
		.select({
			resumeDocumentId: resumeDocuments.id,
			candidateId: resumeDocuments.candidateId,
			isCurrent: resumeDocuments.isCurrent,
			parseStatus: resumeDocuments.parseStatus,
			fileId: files.id,
			fileStatus: files.status,
			storageKey: files.storageKey,
			sha256: files.sha256,
			declaredName: files.declaredName
		})
		.from(resumeDocuments)
		.innerJoin(files, eq(files.id, resumeDocuments.fileId))
		.where(eq(resumeDocuments.id, resumeDocumentId));
	if (!row?.isCurrent || row.parseStatus !== 'pending' || row.fileStatus === 'deleted') return null;
	return row;
}

/** The document is still current and waits for this parse. */
async function stillWaiting(tx: Transaction, target: Target): Promise<boolean> {
	if (!(await lockCandidate(tx, target.candidateId))) return false;
	const [row] = await tx
		.select({ isCurrent: resumeDocuments.isCurrent, parseStatus: resumeDocuments.parseStatus })
		.from(resumeDocuments)
		.where(eq(resumeDocuments.id, target.resumeDocumentId));
	return row?.isCurrent === true && row.parseStatus === 'pending';
}

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

async function recordFailure(tx: Transaction, target: Target, code: RecordedFailure): Promise<void> {
	await tx
		.update(resumeDocuments)
		.set({ parseStatus: statusOfFailure(code), parseError: code })
		.where(eq(resumeDocuments.id, target.resumeDocumentId));
	await tx.update(files).set({ status: 'rejected' }).where(eq(files.id, target.fileId));
}

/**
 * Writes the outcome of a parse while the document still waits for it, and only with `pd_processing` in effect at the
 * write: a consent that lapsed while the parser worked turns any outcome into `no_processing_consent`.
 */
function consentedResult(
	target: Target,
	outcome: { write: (tx: Transaction) => Promise<void>; describe: () => LogFields }
): JobResult {
	let refused = false;
	return {
		isCurrent: (tx) => stillWaiting(tx, target),
		write: async (tx) => {
			if (await processingAllowed(tx, target.candidateId, new Date())) return outcome.write(tx);
			refused = true;
			await recordFailure(tx, target, 'no_processing_consent');
		},
		describe: () =>
			refused
				? { outcome: 'no_processing_consent', parse_status: statusOfFailure('no_processing_consent') }
				: outcome.describe()
	};
}

/** Failures of the platform itself rather than of the file: the resume fails, the log says why at error level. */
type DefectCode = 'object_missing' | 'storage_integrity' | 'storage_unavailable' | 'input_mismatch';

/**
 * Records a parse that gave no text with its code; the file is kept for its owner but marked as rejected. The codes
 * of the parser client and the defects are codes of `resume_documents.parse_error`: a code missing there fails the type
 * check of the calls.
 */
function failureResult(target: Target, code: RecordedFailure): JobResult {
	return consentedResult(target, {
		write: (tx) => recordFailure(tx, target, code),
		describe: () => ({ outcome: code, parse_status: statusOfFailure(code) })
	});
}

/** A resume taken up without `pd_processing` in effect: it fails at once, the file never goes to the parser. */
function refusedResult(target: Target): JobResult {
	return {
		isCurrent: (tx) => stillWaiting(tx, target),
		write: (tx) => recordFailure(tx, target, 'no_processing_consent'),
		describe: () => ({ outcome: 'no_processing_consent', parse_status: statusOfFailure('no_processing_consent') })
	};
}

function extractionResult(target: Target, parsed: ParseResponse, jobId: string): JobResult {
	let extractionId: string | null = null;
	return consentedResult(target, {
		write: async (tx) => {
			await tx
				.insert(documentExtractions)
				.values({
					resumeDocumentId: target.resumeDocumentId,
					extractorName: parsed.extractor.name,
					extractorVersion: parsed.extractor.version,
					inputSha256: parsed.input.sha256,
					status: parsed.status,
					text: parsed.text,
					blocks: parsed.blocks,
					flags: parsed.flags
				})
				.onConflictDoNothing({
					target: [documentExtractions.resumeDocumentId, documentExtractions.extractorVersion]
				});
			const [row] = await tx
				.select({ id: documentExtractions.id })
				.from(documentExtractions)
				.where(
					and(
						eq(documentExtractions.resumeDocumentId, target.resumeDocumentId),
						eq(documentExtractions.extractorVersion, parsed.extractor.version)
					)
				);
			if (!row) throw new Error(`extraction of resume ${target.resumeDocumentId} was not stored`);
			extractionId = row.id;
			await tx
				.update(resumeDocuments)
				.set({ parseStatus: parsed.status === 'complete' ? 'parsed' : 'partial' })
				.where(eq(resumeDocuments.id, target.resumeDocumentId));
			await tx.update(files).set({ status: 'ready' }).where(eq(files.id, target.fileId));
			await enqueueJob(
				tx,
				'resume.extract',
				{ extraction_id: row.id },
				{ inputVersion: row.id, createdBy: { kind: 'system', id: jobId } }
			);
		},
		describe: () => ({
			outcome: 'parsed',
			extraction_id: extractionId,
			status: parsed.status,
			blocks: parsed.blocks.length,
			ocr_pages: parsed.flags.ocrPages.length,
			extractor_version: parsed.extractor.version
		})
	});
}

export interface ResumeParseDeps {
	store: () => ObjectStore;
	parser: () => Docparse;
}

export function createResumeParseHandler(deps: ResumeParseDeps): JobHandler<'resume.parse'> {
	return defineHandler({
		type: 'resume.parse',
		concurrency: 2,
		run: async ({ job, db, requestId, signal, log }) => {
			const target = await loadTarget(db, job.payload.resume_document_id);
			if (!target) return stale;
			if (!(await processingAllowed(db, target.candidateId, new Date()))) return refusedResult(target);
			const defect = (code: DefectCode, message: string) => {
				log.error(`resume parse failed on the platform side: ${message}`, {
					code,
					resume_document_id: target.resumeDocumentId
				});
				return failureResult(target, code);
			};

			let bytes: Uint8Array<ArrayBuffer> | null;
			try {
				bytes = await readObject(deps.store(), target.storageKey, signal);
			} catch (error) {
				if (!(error instanceof StorageError)) throw error;
				if (error.retryable && job.attempt < job.maxAttempts) {
					throw new JobFailure('storage_unavailable', error.message, { retryable: true });
				}
				return defect('storage_unavailable', error.message);
			}
			if (bytes === null) return defect('object_missing', 'the stored object of the resume is missing');
			if (createHash('sha256').update(bytes).digest('hex') !== target.sha256) {
				return defect('storage_integrity', 'the stored object differs from the uploaded file');
			}
			signal.throwIfAborted();

			const parsed = await deps.parser().parse({ bytes, declaredName: target.declaredName, requestId, signal });
			if (!parsed.ok) {
				const { error } = parsed;
				if (error.code === 'cancelled') signal.throwIfAborted();
				if (mayRetry(error, job.attempt, job.maxAttempts)) {
					throw new JobFailure(`docparse_${error.code}`, error.message, {
						retryable: true,
						...(error.code === 'busy' ? { retryAfterSeconds: 10 } : {})
					});
				}
				if (error.code === 'invalid_response' || error.code === 'bad_request') {
					log.error('the parser answered outside its contract', { code: error.code });
				} else if (error.retryable) {
					// The retries of a transient failure (a busy or unreachable parser) are warnings of the worker; the
					// resume left without text after the last one is the failure someone has to look at.
					log.error('the parser failed on every allowed attempt', { code: error.code });
				}
				return failureResult(target, error.code);
			}
			if (parsed.value.input.sha256 !== target.sha256) {
				return defect('input_mismatch', 'the parser read other bytes than the stored file');
			}
			return extractionResult(target, parsed.value, job.id);
		}
	});
}

/** Handler of `resume.parse` for the job registry. */
export const resumeParse = createResumeParseHandler({ store: objectStore, parser: docparse });
