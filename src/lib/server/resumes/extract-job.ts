// Job `resume.extract` (docs/domain.md, sections 9, 16.1, 17.2; docs/contracts.md, sections 3.2, 3.5): the blocks of a
// parsed resume go to the model's `resume-extract/v3`; every item that survives the quote checks becomes a claim with its
// quote, job groups become experience entries, and the profile revision moves with the recalculation enqueued. The
// name, the contacts and the soft skills the reading finds become suggestions for the candidate's own profile fields
// (`profile/suggestions.ts`), never claims. Without
// the model — switched off, not configured, or failing after the job's attempts — the deterministic extractor reads the
// same blocks and its items pass the same checks; the envelope says `rules_only` and why, so the candidate is told to
// check the fields. Nothing is written unless the document is still current and not yet extracted. Without
// `pd_processing` in effect the blocks reach neither the model nor the rules, and a result is not written.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { processingAllowed } from '$lib/server/consent/processing';
import type { Database, Transaction } from '$lib/server/db';
import {
	claims,
	documentExtractions,
	experienceEntries,
	files,
	mlResults,
	resumeDocuments,
	sourceFacts
} from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { canonicalJson } from '$lib/server/json/canonical';
import { LLM_DEFAULT_MAX_CONCURRENCY } from '$lib/server/config';
import { fieldCrypto, type FieldCrypto } from '$lib/server/crypto/fields';
import { modelAdapter } from '$lib/server/ml';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { extractModelEnvelope, type ExtractModelEnvelope } from '$lib/server/ml/envelope';
import type { ResumeOutput } from '$lib/server/ml/extract-output';
import type { Rejected } from '$lib/server/ml/extract-common';
import { checkResumeItems, type ResumeItem } from '$lib/server/ml/resume-extract';
import { insertProfileSuggestions, planProfileSuggestions } from '$lib/server/profile/suggestions';
import { sliceByCodePoints } from '$lib/text/offsets';
import { planEvidence, type EvidencePlan } from './evidence';
import { lockCandidate, recordEvidenceChange, resumeRecordRef } from './revision';
import { extractByRules, RULES_VERSION, type RuleBlock } from './rules';
import { loadResumeTaxonomy, resumeLexicon, type ResumeTaxonomy } from './taxonomy';

export const RESUME_SCHEMA_VERSION = 'resume-extract/v3';

/** `ml_results.input_sha256` of a resume's reading: the hash of the blocks the model sees. */
export function resumeInputSha256(blocks: readonly { id: string; text: string }[]): string {
	return createHash('sha256').update(canonicalJson(blocks), 'utf8').digest('hex');
}

const storedBlocks = z.array(
	z.object({
		id: z.string(),
		kind: z.enum(['heading', 'paragraph', 'list_item', 'table_cell', 'line']),
		column: z.int().min(1).nullable(),
		start: z.int().min(0),
		end: z.int().min(1)
	})
);

interface Target {
	extractionId: string;
	extractorVersion: string;
	resumeDocumentId: string;
	candidateId: string;
	seq: number;
	fileSha256: string;
	blocks: RuleBlock[];
}

async function loadTarget(db: Database, extractionId: string): Promise<Target | null> {
	const [row] = await db
		.select({
			extractionId: documentExtractions.id,
			extractorVersion: documentExtractions.extractorVersion,
			text: documentExtractions.text,
			blocks: documentExtractions.blocks,
			resumeDocumentId: resumeDocuments.id,
			candidateId: resumeDocuments.candidateId,
			isCurrent: resumeDocuments.isCurrent,
			seq: resumeDocuments.seq,
			fileSha256: files.sha256
		})
		.from(documentExtractions)
		.innerJoin(resumeDocuments, eq(resumeDocuments.id, documentExtractions.resumeDocumentId))
		.innerJoin(files, eq(files.id, resumeDocuments.fileId))
		.where(eq(documentExtractions.id, extractionId));
	if (!row?.isCurrent) return null;
	const blocks = storedBlocks.parse(row.blocks).map((block) => ({
		id: block.id,
		kind: block.kind,
		column: block.column,
		text: sliceByCodePoints(row.text, block)
	}));
	return { ...row, blocks };
}

/** The resume already has its evidence: a repeated delivery must not call the model again. */
async function alreadyExtracted(executor: Database | Transaction, target: Target): Promise<boolean> {
	const [fact] = await executor
		.select({ id: sourceFacts.id })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, target.candidateId),
				eq(sourceFacts.sourceRecordRef, resumeRecordRef(target.resumeDocumentId)),
				eq(sourceFacts.status, 'active')
			)
		);
	return fact !== undefined;
}

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

interface Extraction {
	mode: 'model' | 'rules_only';
	/** The model's checked answer as `ml_results.output` keeps it; `null` — the rules read the resume. */
	output: ResumeOutput | null;
	/** Model id or rules version that produced the items. */
	producer: string;
	items: ResumeItem[];
	rejected: Rejected[];
	model: ExtractModelEnvelope | null;
	failure: Record<string, unknown> | null;
	latencyMs: number | null;
}

export interface ResumeExtractDeps {
	adapter: () => Pick<ModelAdapter, 'extract'>;
	/** Seals the suggested name and contacts. */
	crypto: () => FieldCrypto;
	now: () => Date;
}

function rulesExtraction(target: Target, taxonomy: ResumeTaxonomy, failure: Record<string, unknown>): Extraction {
	const started = Date.now();
	const checked = checkResumeItems(extractByRules(target.blocks, taxonomy), target.blocks, resumeLexicon(taxonomy));
	return {
		mode: 'rules_only',
		output: null,
		producer: RULES_VERSION,
		items: checked.items,
		rejected: checked.rejected,
		model: null,
		failure,
		latencyMs: Date.now() - started
	};
}

async function insertEvidence(
	tx: Transaction,
	target: Target,
	plan: EvidencePlan,
	extraction: Extraction,
	mlResultId: string,
	now: Date
): Promise<void> {
	await tx.insert(sourceFacts).values({
		id: plan.fact.id,
		candidateId: target.candidateId,
		source: 'resume',
		factType: 'resume_document',
		sourceRecordRef: plan.fact.sourceRecordRef,
		trustLevel: 'claimed',
		ownershipBasis: 'self_upload',
		payload: plan.fact.payload,
		payloadSha256: plan.fact.payloadSha256,
		observedAt: now,
		lastVerifiedAt: now,
		status: 'active'
	});
	if (plan.entries.length > 0) {
		await tx.insert(experienceEntries).values(
			plan.entries.map((entry) => {
				const { period } = entry;
				return {
					id: entry.id,
					candidateId: target.candidateId,
					factId: plan.fact.id,
					positionTitle: entry.positionTitle,
					roleKey: entry.roleKey,
					organizationName: entry.organizationName,
					periodFrom: period.from?.date ?? null,
					periodTo: period.to?.date ?? null,
					periodFromPrecision: period.from?.precision ?? null,
					periodToPrecision: period.to?.precision ?? null,
					isCurrent: period.isCurrent,
					appliedSkillKeys: entry.appliedSkillKeys,
					quotes: entry.quotes,
					periodStatus: period.status,
					status: 'active' as const
				};
			})
		);
	}
	if (plan.claims.length > 0) {
		await tx.insert(claims).values(
			plan.claims.map((claim) => ({
				id: claim.id,
				candidateId: target.candidateId,
				factId: plan.fact.id,
				claimType: claim.claimType,
				experienceEntryId: claim.experienceEntryId,
				rawText: claim.rawText,
				polarity: claim.polarity,
				skillKey: claim.skillKey,
				normalization: claim.normalization,
				value: claim.value,
				quote: claim.quote,
				extractor: extraction.mode === 'model' ? ('model' as const) : ('rules' as const),
				mlResultId,
				status: 'active' as const
			}))
		);
	}
}

export function createResumeExtractHandler(deps: ResumeExtractDeps): JobHandler<'resume.extract'> {
	return defineHandler({
		type: 'resume.extract',
		// As many jobs as the adapter sends to the runtime at once by default; with a lower `LLM_MAX_CONCURRENCY` the
		// extra jobs wait for a slot in the adapter. The registry is built on import, before the configuration is read.
		concurrency: LLM_DEFAULT_MAX_CONCURRENCY,
		run: async ({ job, db, requestId, signal }) => {
			const target = await loadTarget(db, job.payload.extraction_id);
			if (!target || (await alreadyExtracted(db, target))) return stale;
			if (!(await processingAllowed(db, target.candidateId, deps.now()))) return stale;
			const taxonomy = await loadResumeTaxonomy(db);
			if (!taxonomy) throw new JobFailure('taxonomy_missing', 'no published taxonomy version', { retryable: true });

			const blocks = target.blocks.map((block) => ({ id: block.id, text: block.text }));
			const answer = await deps.adapter().extract(
				{
					schemaVersion: RESUME_SCHEMA_VERSION,
					input: { type: 'document_extraction', id: target.extractionId },
					taxonomyVersionId: taxonomy.id,
					blocks
				},
				resumeLexicon(taxonomy),
				{ signal }
			);
			let extraction: Extraction;
			if (answer.ok) {
				const { value } = answer;
				extraction = {
					mode: 'model',
					output: { items: value.items, rejected: value.rejected },
					producer: value.model.modelId,
					items: value.items,
					rejected: value.rejected,
					model: extractModelEnvelope(value.model, value.stored === true),
					failure: null,
					latencyMs: value.latencyMs
				};
			} else {
				const { error } = answer;
				if (error.code === 'cancelled') {
					signal.throwIfAborted();
					throw new JobFailure('model_cancelled', error.message, { retryable: true });
				}
				if (error.retryable && job.attempt < job.maxAttempts) {
					throw new JobFailure(`model_${error.code}`, error.message, { retryable: true });
				}
				// The model is off or keeps failing: the product's path without it, with the reason on the envelope.
				extraction = rulesExtraction(target, taxonomy, {
					code: error.code,
					retryable: error.retryable,
					attempts: job.attempt,
					...(error.details ? { details: error.details } : {})
				});
			}

			const now = deps.now();
			const plan = planEvidence(extraction.items, {
				resumeDocumentId: target.resumeDocumentId,
				extractionId: target.extractionId,
				fileSha256: target.fileSha256,
				extractorVersion: target.extractorVersion,
				processingMode: extraction.mode,
				producer: extraction.producer,
				taxonomy,
				asOf: now
			});
			const suggestions = planProfileSuggestions(extraction.items);
			const mlResultId = uuidv7();
			const rejected = [...extraction.rejected, ...plan.rejected];
			return {
				isCurrent: async (tx) => {
					if (!(await lockCandidate(tx, target.candidateId))) return false;
					if (!(await processingAllowed(tx, target.candidateId, deps.now()))) return false;
					const [document] = await tx
						.select({ isCurrent: resumeDocuments.isCurrent })
						.from(resumeDocuments)
						.where(eq(resumeDocuments.id, target.resumeDocumentId));
					const [stored] = await tx
						.select({ id: documentExtractions.id })
						.from(documentExtractions)
						.where(eq(documentExtractions.id, target.extractionId));
					return document?.isCurrent === true && stored !== undefined && !(await alreadyExtracted(tx, target));
				},
				write: async (tx) => {
					await tx.insert(mlResults).values({
						id: mlResultId,
						operation: 'extract',
						jobId: job.id,
						inputRef: { type: 'document_extraction', id: target.extractionId },
						inputSha256: resumeInputSha256(blocks),
						inputVersion: String(target.seq),
						schemaVersion: RESUME_SCHEMA_VERSION,
						taxonomyVersionId: taxonomy.id,
						model: extraction.model,
						rulesVersion: extraction.mode === 'rules_only' ? RULES_VERSION : null,
						processingMode: extraction.mode,
						failure: extraction.failure,
						evidenceRefs: {
							fact_id: plan.fact.id,
							blocks: [...new Set(plan.claims.map((claim) => claim.quote.block_id))],
							claims: plan.claims.map((claim) => claim.id),
							experience_entries: plan.entries.map((entry) => entry.id),
							profile_suggestions: suggestions.map((suggestion) => suggestion.id)
						},
						rejectedItems: rejected,
						output: extraction.output,
						latencyMs: extraction.latencyMs
					});
					await insertEvidence(tx, target, plan, extraction, mlResultId, now);
					await insertProfileSuggestions(tx, deps.crypto(), {
						candidateId: target.candidateId,
						extractionId: target.extractionId,
						drafts: suggestions
					});
					await recordEvidenceChange(tx, {
						candidateId: target.candidateId,
						withdrawal: false,
						reason: 'resume_extracted',
						requestId,
						actor: { kind: 'system' },
						createdBy: { kind: 'system', id: job.id }
					});
				},
				describe: () => ({
					mode: extraction.mode,
					failure: typeof extraction.failure?.code === 'string' ? extraction.failure.code : null,
					claims: plan.claims.length,
					experience_entries: plan.entries.length,
					profile_suggestions: suggestions.length,
					rejected: rejected.length
				})
			};
		}
	});
}

/** Handler of `resume.extract` for the job registry. */
export const resumeExtract = createResumeExtractHandler({
	adapter: modelAdapter,
	crypto: fieldCrypto,
	now: () => new Date()
});
