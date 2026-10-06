// Commands of the evaluation bridge: the harness in tools/eval sends one JSON request on stdin and reads one JSON answer
// on stdout (main.ts). Each command runs the product code of this build — no reimplementation — over inputs the harness
// generated, so the metrics describe what the product does.
//   info       — versions of everything that shapes a result, the definitions of the categories (the defining blocks of
//                every pair with their items and skills) and the practice languages of every specialization with the
//                skill each confirms: what the harness decides test results by;
//   extract    — resume files → parse, extraction, evidence rows and the evidence snapshot they give;
//   normalize  — skill mentions → taxonomy keys;
//   evidence   — profile snapshots, optionally with FSP achievements → FSP levels and inferred skills;
//   rank       — candidates (resume rows, FSP achievements, survey answers, test decisions in order) and needs as texts
//                → the product's path of a shortlist for every need — the need read by the rules, the categories of its
//                shortlist, the candidates it admits, their ranking — the candidates without a category apart, and the
//                categories every candidate holds, in a catalog of a temporary database;
//   record     — a finished run → a row of `eval_runs` in the format of the quality panel, with its report file.
import { z } from 'zod';
import {
	blockDefinition,
	CATALOG,
	PRACTICE_LANGUAGE_SKILLS,
	practiceWritesCode
} from '$lib/server/assessments/contract/catalog';
import type { Docparse } from '$lib/server/documents/docparse';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { RESUME_SCHEMA_VERSION } from '$lib/server/resumes/extract-job';
import { RULES_VERSION } from '$lib/server/resumes/rules';
import { matchSkill } from '$lib/server/taxonomy/normalize';
import { fspPageSchema, profileEvidence, snapshotSchema, withFsp } from './evidence';
import { extractDocument, type ExtractedDocument } from './extract';
import { rankCandidates, rankRequestSchema, type RankDeps } from './rank';
import { recordRun, reportFileSchema, runRowSchema, type RecordDeps } from './record';
import type { EvalTaxonomy } from './taxonomy';

const isoDate = z.iso.date().transform((value) => new Date(`${value}T00:00:00Z`));

export const requestSchema = z.discriminatedUnion('command', [
	z.strictObject({ command: z.literal('info') }),
	z.strictObject({
		command: z.literal('extract'),
		mode: z.enum(['rules_only', 'model']),
		as_of: isoDate,
		/** Documents parsed at once; `docparse` itself runs two parses at a time. */
		concurrency: z.int().min(1).max(8),
		documents: z
			.array(z.strictObject({ id: z.string().min(1), path: z.string().min(1), declared_name: z.string().min(1) }))
			.min(1)
	}),
	z.strictObject({ command: z.literal('normalize'), surfaces: z.array(z.string()).min(1) }),
	z.strictObject({
		command: z.literal('evidence'),
		as_of: isoDate,
		profiles: z
			.array(
				z.strictObject({
					id: z.string().min(1),
					snapshot: snapshotSchema,
					/** FSP achievements of the person in the source's wire format; absent — none. */
					fsp: fspPageSchema.optional()
				})
			)
			.min(1)
	}),
	rankRequestSchema,
	z.strictObject({ command: z.literal('record'), row: runRowSchema, report: reportFileSchema })
]);

export type BridgeRequest = z.input<typeof requestSchema>;

export interface BridgeDeps {
	taxonomy: () => Promise<EvalTaxonomy>;
	docparse: () => Docparse;
	adapter: () => Pick<ModelAdapter, 'extract'>;
	record: () => RecordDeps;
	rank: () => RankDeps;
	build: { version: string; commit: string };
}

/** Runs `worker` over the items with at most `limit` at a time; the answers keep the order of the items. */
async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (let index = next++; index < items.length; index = next++) {
			const item = items[index] as T;
			results[index] = await worker(item);
		}
	});
	await Promise.all(lanes);
	return results;
}

export async function handle(raw: unknown, deps: BridgeDeps): Promise<unknown> {
	const request = requestSchema.parse(raw);
	switch (request.command) {
		case 'info': {
			const taxonomy = await deps.taxonomy();
			return {
				product_revision: deps.build.commit,
				app_version: deps.build.version,
				versions: {
					taxonomy: taxonomy.label,
					taxonomy_sha256: taxonomy.contentSha256,
					categorization_ruleset: taxonomy.rules.rulesetVersion,
					catalog: CATALOG.version,
					resume_rules: RULES_VERSION,
					resume_schema: RESUME_SCHEMA_VERSION
				},
				specializations: CATALOG.specializations.map((specialization) => ({
					key: specialization.key,
					open: specialization.availability === 'enabled',
					practice_languages: specialization.practiceLanguages.map((language) => ({
						key: language,
						skill: PRACTICE_LANGUAGE_SKILLS[language]
					}))
				})),
				categories: CATALOG.definitions.map((definition) => ({
					specialization: definition.specialization,
					grade: definition.grade,
					open: CATALOG.specializations.some(
						(s) => s.key === definition.specialization && s.availability === 'enabled'
					),
					/** The practice is a program the candidate writes, so a confirmation names its language. */
					practice_writes_code: practiceWritesCode(definition),
					defining: definition.defining.map((code) => ({
						block: code,
						items: definition.blocks.find((quota) => quota.block === code)?.items ?? 0,
						skill_keys: [...blockDefinition(code).skillKeys]
					}))
				}))
			};
		}
		case 'extract': {
			const taxonomy = await deps.taxonomy();
			const extractDeps = {
				docparse: deps.docparse(),
				taxonomy: taxonomy.resume,
				mode: request.mode,
				adapter: deps.adapter,
				asOf: request.as_of
			};
			const documents: ExtractedDocument[] = await pool(request.documents, request.concurrency, (document) =>
				extractDocument(extractDeps, { id: document.id, path: document.path, declaredName: document.declared_name })
			);
			return { documents };
		}
		case 'normalize': {
			const { resume } = await deps.taxonomy();
			return {
				results: request.surfaces.map((surface) => {
					const match = matchSkill(resume.skills, surface);
					return { surface, skill_key: match.skillKey, method: match.method, score: match.score };
				})
			};
		}
		case 'evidence': {
			const { rules, projection } = await deps.taxonomy();
			return {
				profiles: request.profiles.map((profile) =>
					profileEvidence(
						profile.id,
						profile.fsp === undefined ? profile.snapshot : withFsp(profile.snapshot, profile.fsp, projection),
						rules,
						request.as_of
					)
				)
			};
		}
		case 'rank':
			return rankCandidates(request, deps.rank());
		case 'record':
			return recordRun(deps.record(), request.row, request.report, deps.build.commit);
	}
}
