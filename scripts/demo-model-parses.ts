// The model's parses the demo seed gives again (`seeds/model-parses.json`; docs/deploy.md, «Бюджет шлюза модели»), taken
// from the database of a stand where the model read them: the `ml_results` of the heroes' resumes and of the scenario
// needs with `processing_mode = model` and the model's answer (`output`). Nothing calls the model. Runs with plain Node
// (type stripping), without the SvelteKit runtime:
//   export [file]   — add the parses of the database to the stored ones and write them to `file` (`seeds/model-parses.json`
//                     by default; `-` — to the standard output, the stored ones are read from `seeds/model-parses.json`);
//   missing [file]  — the keys the seeded heroes' resumes and scenario needs have and `file` does not store.
// The seed checks the file when it reads it (src/lib/server/demo/model-parses.ts); this script only carries the answers.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export const SEEDS = fileURLToPath(new URL('../seeds', import.meta.url));

/** An entry of `seeds/model-parses.json`. */
export interface StoredParseEntry {
	schemaVersion: string;
	taxonomy: string;
	inputSha256: string;
	about: string;
	model: { modelId: string; modelRevision: string | null; runtime: string; params: Record<string, unknown> };
	output: unknown;
}

export interface ModelParsesJson {
	description: string;
	parses: StoredParseEntry[];
}

interface DemoJson {
	companies: { key: string; needs?: { key: string; text: string }[] }[];
}

export const parseKey = (entry: Pick<StoredParseEntry, 'schemaVersion' | 'taxonomy' | 'inputSha256'>): string =>
	`${entry.schemaVersion}:${entry.taxonomy}:${entry.inputSha256}`;

/** The scenario needs by the hash of their text, as their parses record it. */
async function scenarioNeeds(seeds: string): Promise<Map<string, string>> {
	const demo = JSON.parse(await readFile(`${seeds}/demo.json`, 'utf8')) as DemoJson;
	const needs = new Map<string, string>();
	for (const company of demo.companies) {
		for (const need of company.needs ?? []) {
			needs.set(createHash('sha256').update(need.text).digest('hex'), `need ${company.key}.${need.key}`);
		}
	}
	return needs;
}

interface ReadingRow {
	schemaVersion: string;
	taxonomy: string;
	inputSha256: string;
	mode: string;
	model: Record<string, unknown> | null;
	output: unknown;
	resumeName: string | null;
}

/**
 * The readings of the heroes' resumes (the originals of the cast, not the copies of demo sessions) and of the scenario
 * needs, the latest per key, in any mode.
 */
async function readings(client: postgres.Sql, needShas: readonly string[]): Promise<ReadingRow[]> {
	return client<ReadingRow[]>`
		select distinct on (m.schema_version, t.label, m.input_sha256)
			m.schema_version as "schemaVersion", t.label as taxonomy, m.input_sha256 as "inputSha256",
			m.processing_mode as mode, m.model, m.output, f.declared_name as "resumeName"
		from ml_results m
		join taxonomy_versions t on t.id = m.taxonomy_version_id
		left join document_extractions e
			on m.input_ref->>'type' = 'document_extraction' and e.id::text = m.input_ref->>'id'
		left join resume_documents d on d.id = e.resume_document_id
		left join candidates c on c.id = d.candidate_id
		left join files f on f.id = d.file_id
		where m.operation = 'extract'
			and (c.demo_original or (m.input_ref->>'type' = 'hiring_need' and m.input_sha256 = any(${needShas})))
		order by m.schema_version, t.label, m.input_sha256, (m.processing_mode = 'model') desc, m.created_at desc`;
}

function modelInfo(envelope: Record<string, unknown> | null, key: string): StoredParseEntry['model'] {
	const { model_id: modelId, model_revision: modelRevision, runtime, params } = envelope ?? {};
	if (
		typeof modelId !== 'string' ||
		(modelRevision !== null && typeof modelRevision !== 'string') ||
		typeof runtime !== 'string' ||
		typeof params !== 'object' ||
		params === null
	) {
		throw new Error(`ml_results of ${key}: the model envelope names no model, revision, runtime or parameters`);
	}
	return { modelId, modelRevision, runtime, params: params as Record<string, unknown> };
}

export async function readParsesFile(path: string): Promise<ModelParsesJson> {
	return JSON.parse(await readFile(path, 'utf8')) as ModelParsesJson;
}

/** The stored parses with the model's parses of the database added; a key of both takes the database's answer. */
export async function exportParses(
	client: postgres.Sql,
	stored: ModelParsesJson,
	seeds: string = SEEDS
): Promise<{ file: ModelParsesJson; added: string[] }> {
	const needs = await scenarioNeeds(seeds);
	const byKey = new Map(stored.parses.map((entry) => [parseKey(entry), entry]));
	const added: string[] = [];
	for (const row of await readings(client, [...needs.keys()])) {
		// The heroes' resumes and the needs the model read: a reading of the rules has no answer to give again.
		if (row.mode !== 'model' || row.output === null) continue;
		const key = parseKey(row);
		byKey.set(key, {
			schemaVersion: row.schemaVersion,
			taxonomy: row.taxonomy,
			inputSha256: row.inputSha256,
			about: row.resumeName === null ? (needs.get(row.inputSha256) ?? 'need') : `resume «${row.resumeName}»`,
			model: modelInfo(row.model, key),
			output: row.output
		});
		added.push(key);
	}
	const parses = [...byKey.values()].sort(
		(a, b) => a.about.localeCompare(b.about) || parseKey(a).localeCompare(parseKey(b))
	);
	return { file: { description: stored.description, parses }, added };
}

/** Keys of the seeded heroes' resumes and scenario needs the file does not store, and the needs not seeded at all. */
export async function missingParses(
	client: postgres.Sql,
	stored: ModelParsesJson,
	seeds: string = SEEDS
): Promise<{ missing: string[]; unseededNeeds: string[] }> {
	const needs = await scenarioNeeds(seeds);
	const keys = new Set(stored.parses.map(parseKey));
	const rows = await readings(client, [...needs.keys()]);
	const seen = new Set(rows.map((row) => row.inputSha256));
	return {
		missing: rows
			.map(parseKey)
			.filter((key) => !keys.has(key))
			.sort(),
		unseededNeeds: [...needs]
			.filter(([sha]) => !seen.has(sha))
			.map(([, about]) => about)
			.sort()
	};
}

if (import.meta.main) {
	const [command, target] = process.argv.slice(2);
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('DATABASE_URL is not set');
	const defaultFile = `${SEEDS}/model-parses.json`;
	const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	try {
		switch (command) {
			case 'export': {
				const out = target ?? defaultFile;
				const { file, added } = await exportParses(client, await readParsesFile(out === '-' ? defaultFile : out));
				const text = `${JSON.stringify(file, null, '\t')}\n`;
				if (out === '-') process.stdout.write(text);
				else await writeFile(out, text);
				console.error(`model parses: ${added.length} from the database, ${file.parses.length} stored`);
				break;
			}
			case 'missing': {
				const { missing, unseededNeeds } = await missingParses(client, await readParsesFile(target ?? defaultFile));
				for (const key of missing) console.log(key);
				if (unseededNeeds.length > 0) console.error(`not seeded: ${unseededNeeds.join(', ')}`);
				console.error(`model parses missing: ${missing.length}`);
				break;
			}
			default:
				throw new Error(`unknown command «${command ?? ''}»: export [file] or missing [file]`);
		}
	} finally {
		await client.end({ timeout: 5 });
	}
}
