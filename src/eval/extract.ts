// `extract` of the bridge: a resume file goes the product's way — `docparse` through its client, the blocks to the
// extractor (the model's `resume-extract/v3`, or the deterministic rules), the items through the same quote checks and
// into evidence rows (src/lib/server/resumes/parse-job.ts, extract-job.ts). Nothing is written: the rows come back
// together with the evidence snapshot they would give (the shape `loadSnapshot` reads them in), the quote of every
// claim with the blocks it points into, the refusals by reason and how long each step took. `rank` stores the rows
// themselves (`evidence`) in the catalog it ranks.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EvidenceSnapshot } from '$lib/server/evidence/types';
import type { Docparse, ParseResponse } from '$lib/server/documents/docparse';
import { uuidv7 } from '$lib/server/ids';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import type { Rejected } from '$lib/server/ml/extract-common';
import { checkResumeItems, type ResumeItem } from '$lib/server/ml/resume-extract';
import { planEvidence, type EvidencePlan } from '$lib/server/resumes/evidence';
import { RESUME_SCHEMA_VERSION } from '$lib/server/resumes/extract-job';
import { extractByRules, RULES_VERSION, type RuleBlock } from '$lib/server/resumes/rules';
import { resumeLexicon, type ResumeTaxonomy } from '$lib/server/resumes/taxonomy';
import { sliceByCodePoints } from '$lib/text/offsets';

export type ExtractMode = 'rules_only' | 'model';

export interface ExtractDeps {
	docparse: Docparse;
	taxonomy: ResumeTaxonomy;
	mode: ExtractMode;
	/** Used only in `model` mode. */
	adapter: () => Pick<ModelAdapter, 'extract'>;
	asOf: Date;
	/** Pause before asking a busy parser again. */
	busyDelayMs?: number;
}

/**
 * A busy parser (two parses at once, contracts 4.3) is asked again; any other failure is the document's result. The
 * parser is shared with the running application, so the wait for a slot is long: two minutes.
 */
const BUSY_ATTEMPTS = 240;
const DEFAULT_BUSY_DELAY_MS = 500;

export interface ExtractedClaim {
	kind: string;
	raw_text: string;
	polarity: string;
	skill_key: string | null;
	normalization_method: string | null;
	value: Record<string, unknown> | null;
	experience_entry_id: string | null;
	/** Code points from the start of the block text (docs/domain.md 9.2). */
	quote: { block_id: string; start: number; end: number; text: string };
}

export interface ExtractedEntry {
	id: string;
	position_title: string | null;
	role_key: string | null;
	organization_name: string | null;
	period: {
		from: string | null;
		from_precision: string | null;
		to: string | null;
		to_precision: string | null;
		is_current: boolean;
		status: string;
	};
	applied_skill_keys: string[];
}

export type ExtractedDocument =
	| {
			id: string;
			ok: true;
			parse: { extractor: string; status: 'complete' | 'partial'; detected_format: string };
			/** The parsed text: the input of every method compared on this document. */
			text: string;
			/** Blocks of the parse: code point offsets in `text`. */
			blocks: { id: string; start: number; end: number }[];
			mode: ExtractMode;
			/** Model id or rules version that produced the items. */
			producer: string;
			/** Why the model's answer was not used; `null` when it was or when rules were asked for. */
			model_failure: string | null;
			claims: ExtractedClaim[];
			entries: ExtractedEntry[];
			/** Items the extractor gave: those kept as claims and those refused, by reason. */
			items: number;
			rejected: Record<string, number>;
			/** Wall time of the parse and of the extraction (model or rules) with its checks, milliseconds. */
			timing: { parse_ms: number; extract_ms: number };
			snapshot: EvidenceSnapshot;
			/** The rows `resume.extract` would insert. */
			evidence: Pick<EvidencePlan, 'fact' | 'claims' | 'entries'>;
	  }
	| { id: string; ok: false; stage: 'parse'; error: { code: string; message: string } };

interface Extraction {
	mode: ExtractMode;
	producer: string;
	items: ResumeItem[];
	rejected: Rejected[];
	modelFailure: string | null;
}

async function parseWithRetry(deps: ExtractDeps, bytes: Uint8Array<ArrayBuffer>, declaredName: string, id: string) {
	for (let attempt = 1; ; attempt++) {
		const result = await deps.docparse.parse({ bytes, declaredName, requestId: `eval-${id}-${attempt}` });
		if (result.ok || result.error.code !== 'busy' || attempt >= BUSY_ATTEMPTS) return result;
		await sleep(deps.busyDelayMs ?? DEFAULT_BUSY_DELAY_MS);
	}
}

async function extractItems(deps: ExtractDeps, blocks: RuleBlock[], extractionId: string): Promise<Extraction> {
	const rules = (modelFailure: string | null): Extraction => {
		const checked = checkResumeItems(extractByRules(blocks, deps.taxonomy), blocks, resumeLexicon(deps.taxonomy));
		return {
			mode: 'rules_only',
			producer: RULES_VERSION,
			items: checked.items,
			rejected: checked.rejected,
			modelFailure
		};
	};
	if (deps.mode === 'rules_only') return rules(null);
	const answer = await deps.adapter().extract(
		{
			schemaVersion: RESUME_SCHEMA_VERSION,
			input: { type: 'document_extraction', id: extractionId },
			taxonomyVersionId: deps.taxonomy.id,
			blocks: blocks.map((block) => ({ id: block.id, text: block.text }))
		},
		resumeLexicon(deps.taxonomy)
	);
	// Without a usable answer the product takes the rules path (extract-job.ts); the run records that it did.
	if (!answer.ok) return rules(answer.error.code);
	return {
		mode: 'model',
		producer: answer.value.model.modelId,
		items: answer.value.items,
		rejected: answer.value.rejected,
		modelFailure: null
	};
}

/** The snapshot the evidence rows give once stored: what `resume.extract` inserts, as `loadSnapshot` reads it. */
export function snapshotOf(plan: EvidencePlan, mode: ExtractMode, candidateId: string): EvidenceSnapshot {
	return {
		candidateId,
		revision: 1,
		facts: [
			{
				id: plan.fact.id,
				source: 'resume',
				factType: 'resume_document',
				sourceRecordRef: plan.fact.sourceRecordRef,
				eventKey: null,
				trustLevel: 'claimed',
				occurredOn: null,
				payload: plan.fact.payload
			}
		],
		claims: plan.claims.map((claim) => ({
			id: claim.id,
			factId: plan.fact.id,
			claimType: claim.claimType,
			extractor: mode === 'model' ? 'model' : 'rules',
			skillKey: claim.skillKey,
			eventKey: null,
			polarity: claim.polarity,
			candidateReview: 'pending',
			experienceEntryId: claim.experienceEntryId,
			value: claim.value
		})),
		experience: plan.entries.map((entry) => ({
			id: entry.id,
			factId: plan.fact.id,
			roleKey: entry.roleKey,
			periodFrom: entry.period.from?.date ?? null,
			periodTo: entry.period.to?.date ?? null,
			periodFromPrecision: entry.period.from?.precision ?? null,
			periodToPrecision: entry.period.to?.precision ?? null,
			isCurrent: entry.period.isCurrent,
			appliedSkillKeys: entry.appliedSkillKeys,
			periodStatus: entry.period.status,
			candidateReview: 'pending'
		}))
	};
}

function countReasons(rejected: readonly Rejected[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const { reason } of rejected) counts[reason] = (counts[reason] ?? 0) + 1;
	return counts;
}

/** A parsed document through extraction and evidence planning. */
export async function readParsed(
	deps: ExtractDeps,
	id: string,
	parsed: ParseResponse,
	parseMs: number
): Promise<ExtractedDocument> {
	const blocks: RuleBlock[] = parsed.blocks.map((block) => ({
		id: block.id,
		kind: block.kind,
		column: block.column,
		text: sliceByCodePoints(parsed.text, block)
	}));
	const extractionId = uuidv7();
	const started = performance.now();
	const extraction = await extractItems(deps, blocks, extractionId);
	const extractMs = performance.now() - started;
	const plan = planEvidence(extraction.items, {
		resumeDocumentId: uuidv7(),
		extractionId,
		fileSha256: parsed.input.sha256,
		extractorVersion: parsed.extractor.version,
		processingMode: extraction.mode,
		producer: extraction.producer,
		taxonomy: deps.taxonomy,
		asOf: deps.asOf
	});
	return {
		id,
		ok: true,
		parse: {
			extractor: `${parsed.extractor.name}@${parsed.extractor.version}`,
			status: parsed.status,
			detected_format: parsed.input.detectedFormat
		},
		text: parsed.text,
		blocks: parsed.blocks.map((block) => ({ id: block.id, start: block.start, end: block.end })),
		mode: extraction.mode,
		producer: extraction.producer,
		model_failure: extraction.modelFailure,
		claims: plan.claims.map((claim) => ({
			kind: claim.claimType,
			raw_text: claim.rawText,
			polarity: claim.polarity,
			skill_key: claim.skillKey,
			normalization_method: typeof claim.normalization?.method === 'string' ? claim.normalization.method : null,
			value: claim.value,
			experience_entry_id: claim.experienceEntryId,
			quote: { block_id: claim.quote.block_id, start: claim.quote.start, end: claim.quote.end, text: claim.quote.text }
		})),
		entries: plan.entries.map((entry) => ({
			id: entry.id,
			position_title: entry.positionTitle,
			role_key: entry.roleKey,
			organization_name: entry.organizationName,
			period: {
				from: entry.period.from?.date ?? null,
				from_precision: entry.period.from?.precision ?? null,
				to: entry.period.to?.date ?? null,
				to_precision: entry.period.to?.precision ?? null,
				is_current: entry.period.isCurrent,
				status: entry.period.status
			},
			applied_skill_keys: entry.appliedSkillKeys
		})),
		items: extraction.items.length + extraction.rejected.length,
		rejected: countReasons([...extraction.rejected, ...plan.rejected]),
		timing: { parse_ms: Math.round(parseMs), extract_ms: Math.round(extractMs) },
		snapshot: snapshotOf(plan, extraction.mode, uuidv7()),
		evidence: { fact: plan.fact, claims: plan.claims, entries: plan.entries }
	};
}

/** A resume file from disk, parsed by `docparse` and extracted. A parser failure is the document's result. */
export async function extractDocument(
	deps: ExtractDeps,
	document: { id: string; path: string; declaredName: string }
): Promise<ExtractedDocument> {
	const bytes = new Uint8Array(await readFile(document.path));
	const started = performance.now();
	const parsed = await parseWithRetry(deps, bytes, document.declaredName, document.id);
	const parseMs = performance.now() - started;
	if (!parsed.ok) {
		const { code, message } = parsed.error;
		return { id: document.id, ok: false, stage: 'parse', error: { code, message } };
	}
	return readParsed(deps, document.id, parsed.value, parseMs);
}
