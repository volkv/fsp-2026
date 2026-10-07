// What the candidate sees of their resumes (docs/domain.md, sections 9, 14, 15; CONCEPT, item 1): every upload with its
// parse status, and for the current one the document text with its blocks, how it was read (with the model or by rules
// only — then the fields must be checked), and each claim and experience entry with the quote it rests on, so a click
// on a fact opens the document at the quoted place.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Database } from '$lib/server/db';
import {
	claims,
	documentExtractions,
	experienceEntries,
	files,
	mlResults,
	resumeDocuments,
	sourceFacts
} from '$lib/server/db/schema';
import { readModelEnvelope, type ModelReading } from '$lib/server/ml/envelope';
import { selfCandidate } from './deps';
import type { ResumeParseError } from './parse-errors';
import type { ResumeParseStatus } from './parse-job';

export interface ResumeUpload {
	resumeDocumentId: string;
	fileId: string;
	seq: number;
	isCurrent: boolean;
	parseStatus: ResumeParseStatus;
	declaredName: string;
	sizeBytes: number;
	uploadedAt: Date;
	/** Why the parse gave no text; `null` while pending or after a parse with text. */
	parseError: ResumeParseError | null;
	/** What the candidate is told when the parse gave no text (docs/contracts.md, section 4.4). */
	failureMessage: string | null;
}

export interface ResumeReading {
	processingMode: 'model' | 'rules_only' | 'partial' | 'failed';
	/** The model that read the resume and its runtime profile (where the text went); `null` — no model read it. */
	model: ModelReading | null;
	/** Shown with a reading without the model. */
	notice: string | null;
	failureCode: string | null;
}

export interface CurrentResume {
	upload: ResumeUpload;
	/** `null` until the parser has answered, or when it gave no text. */
	document: {
		extractionId: string;
		status: 'complete' | 'partial';
		text: string;
		blocks: unknown;
		flags: unknown;
	} | null;
	reading: ResumeReading | null;
	claims: {
		id: string;
		claimType: string;
		rawText: string;
		polarity: string;
		skillKey: string | null;
		value: unknown;
		quote: unknown;
		extractor: string;
		candidateReview: string;
		experienceEntryId: string | null;
	}[];
	experience: {
		id: string;
		positionTitle: string | null;
		roleKey: string | null;
		organizationName: string | null;
		periodFrom: string | null;
		periodTo: string | null;
		periodFromPrecision: string | null;
		periodToPrecision: string | null;
		isCurrent: boolean;
		periodStatus: string;
		appliedSkillKeys: string[];
		quotes: unknown;
		candidateReview: string;
	}[];
}

export interface OwnResumes {
	uploads: ResumeUpload[];
	current: CurrentResume | null;
}

const RULES_ONLY_NOTICE = 'Разбор выполнен без модели — проверьте поля';

const PLATFORM_FAILURE = 'Файл не разобран из-за сбоя на нашей стороне — загрузите его ещё раз немного позже';

/** The exact reason by the recorded code; the codes of the platform's own failures read the same for the candidate. */
const FAILURE_MESSAGES: Record<ResumeParseError, string> = {
	unsupported_format: 'Формат не поддерживается: загрузите PDF или DOCX',
	too_large: 'Файл больше 10 МиБ: загрузите файл меньшего размера',
	unpacked_too_large: 'Файл слишком большой после распаковки: сохраните резюме в PDF без вложенных объектов',
	encrypted: 'Файл защищён паролем: снимите защиту и загрузите его снова',
	corrupt: 'Файл повреждён и не открывается: сохраните его заново и загрузите',
	no_text: 'В файле не найден текст: загрузите файл с текстовым слоем или более чёткий скан',
	timeout: 'Файл разбирался слишком долго: загрузите резюме покороче или в PDF',
	memory_exceeded: 'Файл слишком сложный для разбора: сохраните резюме в PDF и загрузите снова',
	busy: PLATFORM_FAILURE,
	internal: PLATFORM_FAILURE,
	bad_request: PLATFORM_FAILURE,
	unavailable: PLATFORM_FAILURE,
	invalid_response: PLATFORM_FAILURE,
	cancelled: PLATFORM_FAILURE,
	object_missing: PLATFORM_FAILURE,
	storage_integrity: PLATFORM_FAILURE,
	storage_unavailable: PLATFORM_FAILURE,
	input_mismatch: PLATFORM_FAILURE,
	no_processing_consent:
		'Файл не прочитан: согласие на обработку персональных данных не действует — подпишите его на странице «Согласия» и загрузите файл снова',
	unrecorded: 'Файл не удалось разобрать: в нём не найден текст или он повреждён — загрузите другой файл'
};

export async function readOwnResumes(db: Database, subject: AccessSubject): Promise<OwnResumes> {
	const { candidateId } = selfCandidate(subject);
	const rows = await db
		.select({
			resumeDocumentId: resumeDocuments.id,
			fileId: resumeDocuments.fileId,
			seq: resumeDocuments.seq,
			isCurrent: resumeDocuments.isCurrent,
			parseStatus: resumeDocuments.parseStatus,
			parseError: resumeDocuments.parseError,
			declaredName: files.declaredName,
			sizeBytes: files.sizeBytes,
			uploadedAt: resumeDocuments.createdAt
		})
		.from(resumeDocuments)
		.innerJoin(files, eq(files.id, resumeDocuments.fileId))
		.where(eq(resumeDocuments.candidateId, candidateId))
		.orderBy(desc(resumeDocuments.seq));
	const uploads: ResumeUpload[] = rows.map((row) => ({
		...row,
		failureMessage: row.parseError === null ? null : FAILURE_MESSAGES[row.parseError]
	}));
	const upload = uploads.find((u) => u.isCurrent);
	if (!upload) return { uploads, current: null };

	const [extraction] = await db
		.select({
			extractionId: documentExtractions.id,
			status: documentExtractions.status,
			text: documentExtractions.text,
			blocks: documentExtractions.blocks,
			flags: documentExtractions.flags
		})
		.from(documentExtractions)
		.where(eq(documentExtractions.resumeDocumentId, upload.resumeDocumentId))
		.orderBy(desc(documentExtractions.createdAt))
		.limit(1);

	let reading: ResumeReading | null = null;
	if (extraction) {
		const [envelope] = await db
			.select({ mode: mlResults.processingMode, model: mlResults.model, failure: mlResults.failure })
			.from(mlResults)
			.where(
				and(
					eq(mlResults.operation, 'extract'),
					sql`${mlResults.inputRef} ->> 'type' = 'document_extraction'`,
					sql`${mlResults.inputRef} ->> 'id' = ${extraction.extractionId}`
				)
			)
			.orderBy(desc(mlResults.createdAt))
			.limit(1);
		if (envelope) {
			const failure = envelope.failure as { code?: unknown } | null;
			reading = {
				processingMode: envelope.mode,
				model: envelope.mode === 'model' ? readModelEnvelope(envelope.model) : null,
				notice: envelope.mode === 'model' ? null : RULES_ONLY_NOTICE,
				failureCode: typeof failure?.code === 'string' ? failure.code : null
			};
		}
	}

	const facts = await db
		.select({ id: sourceFacts.id })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, candidateId),
				eq(sourceFacts.sourceRecordRef, `resume:${upload.resumeDocumentId}`),
				eq(sourceFacts.status, 'active')
			)
		);
	const factIds = facts.map((f) => f.id);
	const claimRows =
		factIds.length === 0
			? []
			: await db
					.select({
						id: claims.id,
						claimType: claims.claimType,
						rawText: claims.rawText,
						polarity: claims.polarity,
						skillKey: claims.skillKey,
						value: claims.value,
						quote: claims.quote,
						extractor: claims.extractor,
						candidateReview: claims.candidateReview,
						experienceEntryId: claims.experienceEntryId
					})
					.from(claims)
					.where(and(inArray(claims.factId, factIds), eq(claims.status, 'active')))
					.orderBy(claims.id);
	const experience =
		factIds.length === 0
			? []
			: await db
					.select({
						id: experienceEntries.id,
						positionTitle: experienceEntries.positionTitle,
						roleKey: experienceEntries.roleKey,
						organizationName: experienceEntries.organizationName,
						periodFrom: experienceEntries.periodFrom,
						periodTo: experienceEntries.periodTo,
						periodFromPrecision: experienceEntries.periodFromPrecision,
						periodToPrecision: experienceEntries.periodToPrecision,
						isCurrent: experienceEntries.isCurrent,
						periodStatus: experienceEntries.periodStatus,
						appliedSkillKeys: experienceEntries.appliedSkillKeys,
						quotes: experienceEntries.quotes,
						candidateReview: experienceEntries.candidateReview
					})
					.from(experienceEntries)
					.where(and(inArray(experienceEntries.factId, factIds), eq(experienceEntries.status, 'active')))
					.orderBy(experienceEntries.id);

	return {
		uploads,
		current: {
			upload,
			document: extraction ?? null,
			reading,
			claims: claimRows,
			experience
		}
	};
}
