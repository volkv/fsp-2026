// Stored files, resumes and document extractions (domain 15).
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { RESUME_MAX_BYTES } from '../../documents/limits';
import { FAILED_PARSE_STATUSES, RESUME_PARSE_ERRORS } from '../../resumes/parse-errors';
import { enumCheck, id, oneOf, sha256Check, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { users } from './identity';

const FILE_PURPOSES = [
	'resume',
	'authority_evidence',
	'company_authority_evidence',
	'assessment_artifact',
	'source_batch',
	'export'
] as const;
const FILE_STATUSES = ['uploaded', 'ready', 'rejected', 'deleted'] as const;

export const files = pgTable(
	'files',
	{
		id: id(),
		ownerUserId: uuid()
			.notNull()
			.references(() => users.id),
		purpose: text({ enum: FILE_PURPOSES }).notNull(),
		storageKey: text().notNull().unique('files_storage_key'),
		sha256: text().notNull(),
		sizeBytes: bigint({ mode: 'number' }).notNull(),
		declaredName: text().notNull(),
		detectedMime: text().notNull(),
		status: text({ enum: FILE_STATUSES }).notNull(),
		retentionUntil: date({ mode: 'string' }),
		...timestamps()
	},
	(t) => [
		enumCheck('files', 'purpose', t.purpose, FILE_PURPOSES),
		enumCheck('files', 'status', t.status, FILE_STATUSES),
		sha256Check('files', 'sha256', t.sha256),
		check('files_size', sql`${t.sizeBytes} >= 0`),
		check('files_resume_size', sql`${t.purpose} <> 'resume' or ${t.sizeBytes} <= ${sql.raw(String(RESUME_MAX_BYTES))}`),
		index('files_owner').on(t.ownerUserId)
	]
);

const PARSE_STATUSES = ['pending', 'parsed', 'partial', 'unsupported_format', 'failed'] as const;

export const resumeDocuments = pgTable(
	'resume_documents',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		fileId: uuid()
			.notNull()
			.references(() => files.id),
		seq: integer().notNull(),
		isCurrent: boolean().notNull(),
		parseStatus: text({ enum: PARSE_STATUSES }).notNull(),
		/** Why the parse gave no text; set exactly when the status is `failed` or `unsupported_format`. */
		parseError: text({ enum: RESUME_PARSE_ERRORS }),
		...timestamps()
	},
	(t) => [
		enumCheck('resume_documents', 'parse_status', t.parseStatus, PARSE_STATUSES),
		enumCheck('resume_documents', 'parse_error', t.parseError, RESUME_PARSE_ERRORS),
		check(
			'resume_documents_parse_error_status',
			sql`(${t.parseError} is not null) = (${oneOf(t.parseStatus, FAILED_PARSE_STATUSES)})`
		),
		check(
			'resume_documents_unsupported_format_error',
			sql`(${t.parseStatus} = 'unsupported_format') = (${t.parseError} is not distinct from 'unsupported_format')`
		),
		check('resume_documents_seq_positive', sql`${t.seq} >= 1`),
		unique('resume_documents_candidate_seq').on(t.candidateId, t.seq),
		uniqueIndex('resume_documents_current')
			.on(t.candidateId)
			.where(sql`${t.isCurrent}`)
	]
);

const EXTRACTION_STATUSES = ['complete', 'partial'] as const;

export const documentExtractions = pgTable(
	'document_extractions',
	{
		id: id(),
		resumeDocumentId: uuid()
			.notNull()
			.references(() => resumeDocuments.id),
		extractorName: text().notNull(),
		extractorVersion: text().notNull(),
		inputSha256: text().notNull(),
		status: text({ enum: EXTRACTION_STATUSES }).notNull(),
		text: text().notNull(),
		blocks: jsonb().notNull(),
		flags: jsonb().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('document_extractions', 'status', t.status, EXTRACTION_STATUSES),
		sha256Check('document_extractions', 'input_sha256', t.inputSha256),
		unique('document_extractions_document_version').on(t.resumeDocumentId, t.extractorVersion)
	]
);
