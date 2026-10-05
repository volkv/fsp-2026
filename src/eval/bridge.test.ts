import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocparseResult, ParseResponse } from '$lib/server/documents/docparse';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { fail } from '$lib/server/ml/result';
import { handle, requestSchema, type BridgeDeps } from './bridge';
import { fspEvidence, fspPageSchema, snapshotSchema } from './evidence';
import type { ExtractedDocument } from './extract';
import { loadEvalTaxonomy, type EvalTaxonomy } from './taxonomy';

const RESUME: [ParseResponse['blocks'][number]['kind'], string][] = [
	['heading', 'Опыт работы'],
	['paragraph', 'Март 2021 — настоящее время'],
	['paragraph', 'ООО «Северный Код»'],
	['paragraph', 'Python-разработчик'],
	['list_item', '• Разработка сервисов на Python и Django, PostgreSQL'],
	['list_item', '• Руководил командой из 5 разработчиков'],
	['heading', 'Ключевые навыки'],
	['paragraph', 'Python, Django, Postgres, Docker, Kuberentes']
];

function parsed(blocks: typeof RESUME): ParseResponse {
	let text = '';
	const out: ParseResponse['blocks'] = [];
	blocks.forEach(([kind, body], index) => {
		if (index > 0) text += '\n\n';
		const start = text.length;
		text += body;
		out.push({
			id: `d-b${String(index + 1).padStart(3, '0')}`,
			page: null,
			kind,
			column: null,
			start,
			end: text.length
		});
	});
	return {
		schemaVersion: 'docparse/v1',
		extractor: { name: 'docparse', version: 'test' },
		input: { sha256: 'a'.repeat(64), sizeBytes: 100, detectedFormat: 'docx', pageCount: null },
		status: 'complete',
		text,
		blocks: out,
		flags: { ocrUsed: false, ocrPages: [], incompleteReasons: [], externalResourcesIgnored: false },
		stats: { durationMs: 1 }
	};
}

let taxonomy: EvalTaxonomy;
let resumePath: string;

beforeAll(async () => {
	taxonomy = await loadEvalTaxonomy(fileURLToPath(new URL('../../taxonomy', import.meta.url)));
	resumePath = join(await mkdtemp(join(tmpdir(), 'eval-bridge-')), 'resume.docx');
	await writeFile(resumePath, 'bytes of a resume');
});

function deps(overrides: Partial<BridgeDeps> & { parses?: DocparseResult[] } = {}): BridgeDeps {
	const parses = overrides.parses ?? [{ ok: true, value: parsed(RESUME) }];
	const parse = vi.fn(() => {
		const next = parses.length > 1 ? parses.shift() : parses[0];
		if (!next) throw new Error('no parse answer');
		return Promise.resolve(next);
	});
	return {
		taxonomy: () => Promise.resolve(taxonomy),
		docparse: () => ({ parse }),
		adapter: () => ({ extract: () => Promise.resolve(fail('disabled', 'extract: not configured')) }),
		record: () => {
			throw new Error('no database in unit tests');
		},
		rank: () => {
			throw new Error('no database in unit tests');
		},
		build: { version: '0.0.0', commit: 'abc123' },
		...overrides
	};
}

const extractRequest = (mode: 'rules_only' | 'model') => ({
	command: 'extract',
	mode,
	as_of: '2026-09-01',
	concurrency: 2,
	documents: [{ id: 'p1', path: resumePath, declared_name: 'resume.docx' }]
});

async function extractOne(bridgeDeps: BridgeDeps, mode: 'rules_only' | 'model' = 'rules_only') {
	const answer = (await handle(extractRequest(mode), bridgeDeps)) as { documents: ExtractedDocument[] };
	const [document] = answer.documents;
	if (!document) throw new Error('no document in the answer');
	return document;
}

describe('evaluation bridge', () => {
	it('reads a resume the product way: rules, evidence rows and the snapshot they give', async () => {
		const document = await extractOne(deps());
		if (!document.ok) throw new Error('extraction failed');
		expect(document).toMatchObject({ mode: 'rules_only', producer: 'resume-rules/3', model_failure: null });
		const skills = document.claims.filter((c) => c.kind === 'skill_mention').map((c) => c.skill_key);
		expect(skills).toEqual(expect.arrayContaining(['python', 'django', 'postgresql', 'docker']));
		expect(document.entries).toHaveLength(1);
		expect(document.entries[0]).toMatchObject({
			role_key: 'backend',
			organization_name: 'ООО «Северный Код»',
			period: { from: '2021-03-01', from_precision: 'month', is_current: true, status: 'valid' }
		});
		expect(document.claims.find((c) => c.kind === 'responsibility_marker')?.value).toEqual({ marker: 'team_lead' });
		// Every quote stands in the parsed text at its block's offset plus its own, in code points.
		const points = Array.from(document.text);
		for (const claim of document.claims) {
			const block = document.blocks.find((b) => b.id === claim.quote.block_id);
			if (!block) throw new Error(`no block ${claim.quote.block_id}`);
			expect(points.slice(block.start + claim.quote.start, block.start + claim.quote.end).join('')).toBe(
				claim.quote.text
			);
		}
		expect(document.items).toBe(document.claims.length + Object.values(document.rejected).reduce((a, b) => a + b, 0));
		expect(document.timing.extract_ms).toBeGreaterThanOrEqual(0);
		// The snapshot is what the evidence calculation reads once the rows are stored.
		const snapshot = snapshotSchema.parse(document.snapshot);
		expect(snapshot.facts).toMatchObject([{ source: 'resume', trustLevel: 'claimed' }]);
		expect(snapshot.claims.every((c) => c.extractor === 'rules' && c.candidateReview === 'pending')).toBe(true);
		// The rows `rank` stores are the ones the snapshot was read from.
		expect(document.evidence.claims.map((c) => c.id)).toEqual(snapshot.claims.map((c) => c.id));
		expect(document.evidence.entries.map((e) => e.id)).toEqual(snapshot.experience.map((e) => e.id));
		expect(document.evidence.fact.id).toBe(snapshot.facts[0]?.id);

		const computed = (await handle(
			{ command: 'evidence', as_of: '2026-09-01', profiles: [{ id: 'p1', snapshot: document.snapshot }] },
			deps()
		)) as { profiles: { id: string; skills: { skill_key: string; badge_trust: string | null }[] }[] };
		// A resume gives skills without a badge of a check; it assigns no category.
		const inferred = computed.profiles[0]?.skills ?? [];
		expect(inferred.map((skill) => skill.skill_key)).toContain('python');
		expect(inferred.every((skill) => skill.badge_trust === null)).toBe(true);
		expect(computed.profiles[0]).not.toHaveProperty('assignments');
	});

	it('adds FSP achievements the synchronization way and reports the FSP levels', async () => {
		const competition = {
			id: 'c1',
			ekpNumber: null,
			title: 'Чемпионат России',
			discipline: 'product',
			level: 'russian_championship',
			stage: 'single',
			ageGroup: 'adults',
			format: 'team',
			startDate: '2025-05-10',
			online: false
		};
		const result = (id: string, status: string) => ({
			id,
			competitionId: 'c1',
			place: 1,
			evskFulfilled: 'MS',
			status,
			team: { id: 't1', name: 'Команда', size: 4, role: 'captain', specialization: 'backend' }
		});
		const page = {
			athlete: { fspId: 'a1', lastName: 'Иванов', firstName: 'Иван', birthYear: 2001 },
			qualifications: [],
			results: [result('r1', 'official'), result('r2', 'annulled')],
			competitions: [competition],
			generatedAt: '2026-09-01T00:00:00Z',
			sourceVersion: 'v1',
			page: { number: 1, size: 100, totalPages: 1, totalResults: 2 },
			complete: true
		};
		const empty = { candidateId: 'x', revision: 1, facts: [], claims: [], experience: [] };

		const evidence = fspEvidence(fspPageSchema.parse(page), taxonomy.projection, 'x');
		// The annulled result is not an active fact; the official one gives claims of the projection rules.
		expect(evidence.facts).toMatchObject([
			{ source: 'fsp', trustLevel: 'fsp_verified', sourceRecordRef: 'fsp:result:r1' }
		]);
		expect(evidence.claims.length).toBeGreaterThan(0);
		expect(evidence.claims.every((c) => c.extractor === 'source_mapping' && c.factId === evidence.facts[0]?.id)).toBe(
			true
		);

		const answer = (await handle(
			{
				command: 'evidence',
				as_of: '2026-09-01',
				profiles: [
					{ id: 'without', snapshot: empty },
					{ id: 'with', snapshot: empty, fsp: page }
				]
			},
			deps()
		)) as { profiles: { skills: unknown[]; fsp_levels: unknown[] }[] };
		const [without, withFsp] = answer.profiles;
		expect(without).toMatchObject({ skills: [], fsp_levels: [] });
		expect(withFsp?.fsp_levels).toEqual([{ discipline: 'product', level: 'L5' }]);
		expect(withFsp?.skills.length).toBeGreaterThan(0);

		// A record spread over pages is not one athlete's whole record.
		const partial = { ...page, page: { ...page.page, totalPages: 2 } };
		const request = {
			command: 'evidence',
			as_of: '2026-09-01',
			profiles: [{ id: 'p', snapshot: empty, fsp: partial }]
		};
		expect(requestSchema.safeParse(request).success).toBe(false);
	});

	it('asks a busy parser again and reports any other parser failure as the result of the document', async () => {
		const busy: DocparseResult = { ok: false, error: { code: 'busy', retryable: true, message: 'busy' } };
		const bridgeDeps = deps({ parses: [busy, { ok: true, value: parsed(RESUME) }] });
		expect((await extractOne(bridgeDeps)).ok).toBe(true);

		const corrupt: DocparseResult = { ok: false, error: { code: 'corrupt', retryable: false, message: 'broken' } };
		expect(await extractOne(deps({ parses: [corrupt] }))).toEqual({
			id: 'p1',
			ok: false,
			stage: 'parse',
			error: { code: 'corrupt', message: 'broken' }
		});
	});

	it('in model mode takes the rules path when the model gives no answer, and says why', async () => {
		const fallback = await extractOne(deps(), 'model');
		expect(fallback).toMatchObject({ ok: true, mode: 'rules_only', model_failure: 'disabled' });

		const extract = vi.fn<Pick<ModelAdapter, 'extract'>['extract']>((request) => {
			const block = request.blocks.find((b) => b.text.includes('Django'));
			if (!block) throw new Error('no block');
			return Promise.resolve({
				ok: true,
				value: {
					model: { modelId: 'extractor@test', modelRevision: null, params: {} },
					items: [],
					rejected: [],
					attempts: 1,
					latencyMs: 5
				}
			});
		});
		const modelled = await extractOne(deps({ adapter: () => ({ extract }) }), 'model');
		expect(modelled).toMatchObject({ ok: true, mode: 'model', producer: 'extractor@test', claims: [] });
		expect(extract).toHaveBeenCalledOnce();
	});

	it('normalizes spellings with the taxonomy of the checkout and reports its versions', async () => {
		const answer = (await handle({ command: 'normalize', surfaces: ['Postgres', 'Trello'] }, deps())) as {
			results: { skill_key: string | null }[];
		};
		expect(answer.results.map((r) => r.skill_key)).toEqual(['postgresql', null]);
		expect(await handle({ command: 'info' }, deps())).toMatchObject({
			product_revision: 'abc123',
			versions: { taxonomy: taxonomy.label, resume_rules: 'resume-rules/3', resume_schema: 'resume-extract/v2' }
		});
	});

	it('refuses a run row the quality panel could not read', () => {
		const row = {
			dataset_id: 'synthetic-resumes-v1',
			dataset_size: 3,
			dataset_provenance: 'synthetic',
			split: 'holdout',
			versions: { taxonomy: '2026.09.3' },
			processing_mode: 'rules_only',
			thresholds: { 'resume.skills_f1': { min: 0.8 } },
			metrics: { 'resume.skills_f1': { value: 0.9, baseline: 0.7, n: 3 } }
		};
		const report = { path: '/out/runs/r/report.json', name: 'eval-r.json', owner_email: 'admin@example.com' };
		expect(requestSchema.safeParse({ command: 'record', row, report }).success).toBe(true);
		// The row goes with its report file: a run without one is not recorded.
		expect(requestSchema.safeParse({ command: 'record', row }).success).toBe(false);
		const badKey = { ...row, metrics: { f1: { value: 0.9 } }, thresholds: {} };
		expect(requestSchema.safeParse({ command: 'record', row: badKey, report }).success).toBe(false);
		const orphanThreshold = { ...row, thresholds: { 'matching.ndcg_at_10': { min: 0.5 } } };
		expect(requestSchema.safeParse({ command: 'record', row: orphanThreshold, report }).success).toBe(false);
		expect(requestSchema.safeParse({ command: 'rank' }).success).toBe(false);
	});
});
