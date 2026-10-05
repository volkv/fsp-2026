// Checked items of a resume → the evidence rows (docs/domain.md, sections 9.1, 9.2, 9.5): one `resume_document` fact,
// a claim per item with its quote, and an experience entry per job group. Values of the candidate's own profile fields
// (the name, the contacts, the soft skills) are not evidence and never become claims: `profile/suggestions.ts` plans them. Pure: the same items give the same rows, the
// identifiers are generated here so that the claims and the entries can refer to each other before the insert.
import { createHash } from 'node:crypto';
import { canonicalJson } from '$lib/server/json/canonical';
import { uuidv7 } from '$lib/server/ids';
import type { Rejected } from '$lib/server/ml/extract-common';
import {
	isEvidenceItem,
	type EvidenceItemKind,
	type ResumeItem,
	type ResumeItemOf
} from '$lib/server/ml/resume-extract';
import { matchSkill } from '$lib/server/taxonomy/normalize';
import { findMarker } from './markers';
import { parsePeriod, type ParsedPeriod } from './periods';
import { resumeRecordRef } from './revision';
import { roleOfTitle } from '$lib/server/taxonomy/roles';
import type { ResumeTaxonomy } from './taxonomy';

export interface StoredQuote {
	extraction_id: string;
	block_id: string;
	start: number;
	end: number;
	text: string;
}

export interface FactDraft {
	id: string;
	sourceRecordRef: string;
	payload: Record<string, unknown>;
	payloadSha256: string;
}

export interface ClaimDraft {
	id: string;
	claimType: EvidenceItemKind;
	experienceEntryId: string | null;
	rawText: string;
	polarity: ResumeItem['polarity'];
	skillKey: string | null;
	normalization: Record<string, unknown> | null;
	value: Record<string, unknown> | null;
	quote: StoredQuote;
}

export interface EntryDraft {
	id: string;
	positionTitle: string | null;
	roleKey: string | null;
	organizationName: string | null;
	period: ParsedPeriod;
	appliedSkillKeys: string[];
	quotes: StoredQuote[];
}

export interface EvidencePlan {
	fact: FactDraft;
	claims: ClaimDraft[];
	entries: EntryDraft[];
	/** Items the product does not store although they passed the quote checks. */
	rejected: Rejected[];
}

export interface EvidenceSource {
	resumeDocumentId: string;
	extractionId: string;
	fileSha256: string;
	extractorVersion: string;
	processingMode: 'model' | 'rules_only';
	/** Model id or rules version that produced the items. */
	producer: string;
	taxonomy: ResumeTaxonomy;
	asOf: Date;
}

/** A native language tells origin, not a skill (domain 8): such a level is never stored. */
const NATIVE_LANGUAGE = /(родн\p{L}*|native|носител\p{L}*|mother tongue)/iu;

function periodValue(period: ParsedPeriod): Record<string, unknown> {
	return {
		from: period.from?.date ?? null,
		from_precision: period.from?.precision ?? null,
		to: period.to?.date ?? null,
		to_precision: period.to?.precision ?? null,
		is_current: period.isCurrent,
		status: period.status
	};
}

export function planEvidence(items: readonly ResumeItem[], source: EvidenceSource): EvidencePlan {
	const payload = {
		resume_document_id: source.resumeDocumentId,
		extraction_id: source.extractionId,
		file_sha256: source.fileSha256,
		extractor_version: source.extractorVersion,
		processing_mode: source.processingMode,
		producer: source.producer,
		taxonomy_version_id: source.taxonomy.id
	};
	const fact: FactDraft = {
		id: uuidv7(),
		sourceRecordRef: resumeRecordRef(source.resumeDocumentId),
		payload,
		payloadSha256: createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
	};
	const quoteOf = (item: ResumeItem): StoredQuote => ({
		extraction_id: source.extractionId,
		block_id: item.quote.blockId,
		start: item.quote.start,
		end: item.quote.end,
		text: item.quote.text
	});

	const rejected: Rejected[] = [];
	const kept = items.filter(isEvidenceItem).filter((item) => {
		const native =
			item.kind === 'language_level' && NATIVE_LANGUAGE.test(`${item.rawText} ${item.level ?? ''} ${item.quote.text}`);
		if (native) rejected.push({ item, reason: 'forbidden_field' });
		return !native;
	});

	const groups = new Map<string, ResumeItemOf<EvidenceItemKind>[]>();
	for (const item of kept) {
		if (item.group === null) continue;
		groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
	}
	const entryIds = new Map([...groups.keys()].map((label) => [label, uuidv7()]));

	const claims: ClaimDraft[] = kept.map((item) => {
		const base = {
			id: uuidv7(),
			claimType: item.kind,
			experienceEntryId: item.group === null ? null : (entryIds.get(item.group) ?? null),
			rawText: item.rawText,
			polarity: item.polarity,
			skillKey: null,
			normalization: null,
			value: null,
			quote: quoteOf(item)
		};
		switch (item.kind) {
			case 'skill_mention': {
				const match = matchSkill(source.taxonomy.skills, item.rawText);
				return {
					...base,
					skillKey: match.skillKey,
					normalization: { method: match.method, score: match.score, alternatives: match.alternatives }
				};
			}
			case 'experience_period':
				return { ...base, value: periodValue(parsePeriod(item.periodFrom, item.periodTo, source.asOf)) };
			case 'role_title':
				return { ...base, value: { role_key: roleOfTitle(item.rawText, source.taxonomy.roles) } };
			case 'responsibility_marker': {
				const marker = findMarker(item.quote.text)?.marker ?? null;
				return { ...base, value: marker === null ? null : { marker } };
			}
			case 'language_level':
				return { ...base, value: item.level === null ? null : { level: item.level } };
			case 'organization':
			case 'education':
			case 'achievement_mention':
				return base;
		}
	});

	const entries: EntryDraft[] = [...groups.entries()].map(([label, group]) => {
		const first = (kind: EvidenceItemKind) => group.find((item) => item.kind === kind) ?? null;
		const title = first('role_title');
		const periodItem = first('experience_period');
		const organization = first('organization')?.rawText ?? periodItem?.organization ?? null;
		const id = entryIds.get(label);
		if (!id) throw new Error(`experience group ${label} has no id`);
		const skills = claims.filter(
			(claim) =>
				claim.experienceEntryId === id &&
				claim.claimType === 'skill_mention' &&
				claim.polarity === 'asserted' &&
				claim.skillKey !== null
		);
		return {
			id,
			positionTitle: title?.rawText ?? null,
			roleKey: title ? roleOfTitle(title.rawText, source.taxonomy.roles) : null,
			organizationName: organization,
			period: periodItem
				? parsePeriod(periodItem.periodFrom, periodItem.periodTo, source.asOf)
				: { from: null, to: null, isCurrent: false, status: 'missing' },
			appliedSkillKeys: [
				...new Set(skills.flatMap((claim) => (claim.skillKey === null ? [] : [claim.skillKey])))
			].sort(),
			quotes: group.map(quoteOf)
		};
	});

	return { fact, claims, entries, rejected };
}
