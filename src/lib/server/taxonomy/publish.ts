// Publication of a taxonomy release (docs/domain.md section 11). A published version is immutable (migration 0002):
// the same label with the same content is a no-op, the same label with other content is refused.
// Imported by plain Node (scripts/seed-taxonomy.ts): relative imports with extensions, erasable syntax only.
import type postgres from 'postgres';
import { uuidv7 } from '../ids.ts';
import { insertJob, postgresStatements } from '../jobs/insert.ts';
import { canonicalJson } from '../json/canonical.ts';
import { TaxonomyError, contentHash, type TaxonomyContent, type TaxonomyRelease } from './release.ts';

export interface RulesetOutcome {
	version: number;
	outcome: 'created' | 'unchanged';
}

export interface PublishOutcome {
	label: string;
	taxonomyVersionId: string;
	taxonomy: 'published' | 'unchanged';
	contentSha256: string;
	/** Categorization rule set. */
	ruleset: RulesetOutcome;
	matchRuleset: RulesetOutcome;
}

type Executor = postgres.Sql | postgres.TransactionSql;

/** Rows per insert statement: bounds the size of one JSON parameter. */
const BATCH = 500;

/**
 * Publishes the release as a new taxonomy version together with its categorization and match rule sets, in one
 * transaction. Concurrent calls are serialized: a later call waits for the earlier one, sees its version and returns
 * `unchanged`. A new rule set enqueues `derivations.reconcile` in the same transaction: what was computed on the
 * previous ones is recalculated from the commit on, not from the next hourly run.
 */
export async function publishTaxonomy(sql: postgres.Sql, release: TaxonomyRelease): Promise<PublishOutcome> {
	return sql.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended('taxonomy.publish', 0))`;

		const [existing] = await tx<{ id: string; status: string }[]>`
			select id, status from taxonomy_versions where label = ${release.label}
		`;
		let taxonomyVersionId: string;
		let taxonomy: PublishOutcome['taxonomy'];
		if (existing) {
			if (existing.status === 'draft') {
				throw new TaxonomyError(
					'draft_exists',
					`taxonomy version ${release.label} exists as an unfinished draft; it is not produced by publication`
				);
			}
			const stored = contentHash(await readContent(tx, existing.id));
			if (stored !== release.contentSha256) {
				throw new TaxonomyError(
					'version_changed',
					`taxonomy version ${release.label} is already ${existing.status} with other content ` +
						`(stored ${stored}, files ${release.contentSha256}); a change needs a new release label`
				);
			}
			taxonomyVersionId = existing.id;
			taxonomy = 'unchanged';
		} else {
			taxonomyVersionId = uuidv7();
			await insertContent(tx, taxonomyVersionId, release);
			taxonomy = 'published';
		}

		const ruleset = await storeRuleset(tx, taxonomyVersionId, release.ruleset, {
			table: 'categorization_rulesets',
			name: 'categorization rule set',
			changed: 'ruleset_changed'
		});
		const matchRuleset = await storeRuleset(tx, taxonomyVersionId, release.matchRuleset, {
			table: 'match_rulesets',
			name: 'match rule set',
			changed: 'match_ruleset_changed'
		});
		if (ruleset.outcome === 'created' || matchRuleset.outcome === 'created') await enqueueReconcile(tx);

		return {
			label: release.label,
			taxonomyVersionId,
			taxonomy,
			contentSha256: release.contentSha256,
			ruleset,
			matchRuleset
		};
	});
}

/**
 * Stores a rule set bound to the taxonomy version unless the same version already exists. The same version with other
 * parameters or another taxonomy version is refused: a stored rule set never changes.
 */
async function storeRuleset(
	tx: Executor,
	taxonomyVersionId: string,
	ruleset: { version: number; params: unknown },
	kind: {
		table: 'categorization_rulesets' | 'match_rulesets';
		name: string;
		changed: 'ruleset_changed' | 'match_ruleset_changed';
	}
): Promise<RulesetOutcome> {
	const [stored] = await tx<{ taxonomy_version_id: string; params: string }[]>`
		select taxonomy_version_id, params::text as params from ${tx(kind.table)} where version = ${ruleset.version}
	`;
	if (stored) {
		if (
			stored.taxonomy_version_id !== taxonomyVersionId ||
			canonicalJson(JSON.parse(stored.params)) !== canonicalJson(ruleset.params)
		) {
			throw new TaxonomyError(
				kind.changed,
				`${kind.name} version ${ruleset.version} already exists with other parameters or another taxonomy ` +
					`version; a change needs a new rule set version`
			);
		}
		return { version: ruleset.version, outcome: 'unchanged' };
	}
	// The derivations reconciliation (`derivations/reconcile.ts`) takes a job created after `created_at` of the rule set
	// in force for one computed on it. The lock orders every job after this commit: a job inserted before the lock was
	// created earlier than the timestamp taken below, and one inserted after it waits for the commit and so reads the
	// new rule set. It blocks writes to the queue until the commit, which follows at once.
	await tx`lock table jobs in share mode`;
	await tx`
		insert into ${tx(kind.table)} (id, version, taxonomy_version_id, params, created_at)
		values (
			${uuidv7()}, ${ruleset.version}, ${taxonomyVersionId}, ${canonicalJson(ruleset.params)}::text::jsonb,
			clock_timestamp()
		)
	`;
	return { version: ruleset.version, outcome: 'created' };
}

/** The reconciliation of the current hour; a run of the hour already waiting absorbs it. */
async function enqueueReconcile(tx: Executor): Promise<void> {
	const period = new Date().toISOString().slice(0, 13);
	await insertJob(
		postgresStatements(tx),
		'derivations.reconcile',
		{ period },
		{ inputVersion: period, createdBy: { kind: 'system', id: 'taxonomy.publish' } }
	);
}

async function insertContent(tx: Executor, versionId: string, release: TaxonomyRelease): Promise<void> {
	const { content } = release;
	await tx`
		insert into taxonomy_versions (id, label, status, sources)
		values (${versionId}, ${release.label}, 'draft', ${canonicalJson(content.sources)}::text::jsonb)
	`;
	const withVersion = <T extends object>(rows: readonly T[]) =>
		rows.map((row) => ({ taxonomy_version_id: versionId, ...row }));

	await insertRows(tx, 'roles', withVersion(content.roles));
	await insertRows(tx, 'skills', withVersion(content.skills));
	await insertRows(tx, 'skill_aliases', withVersion(content.skillAliases));
	await insertRows(tx, 'grades', withVersion(content.grades));
	await insertRows(tx, 'work_formats', withVersion(content.workFormats));
	await insertRows(
		tx,
		'fsp_projection_rules',
		withVersion(content.fspProjectionRules).map((r) => ({ id: uuidv7(), ...r }))
	);
	await insertRows(tx, 'fsp_strength_params', withVersion([content.fspStrengthParams]));
	await insertRows(tx, 'fsp_level_rules', withVersion(content.fspLevelRules));
	await insertRows(tx, 'receipt_templates', withVersion(content.receiptTemplates));
	await insertRows(
		tx,
		'salary_references',
		withVersion(content.salaryReferences).map((r) => ({ id: uuidv7(), ...r }))
	);

	await tx`
		update taxonomy_versions set status = 'published', published_at = now(), updated_at = now()
		where id = ${versionId}
	`;
}

/**
 * Inserts rows whose keys are column names. Rows travel as one JSON text and the database maps them onto the
 * table type, so `jsonb`, `text[]`, `numeric` and timestamps do not depend on the serializers of the client.
 */
async function insertRows(tx: Executor, table: string, rows: readonly object[]): Promise<void> {
	for (let start = 0; start < rows.length; start += BATCH) {
		const batch = canonicalJson(rows.slice(start, start + BATCH));
		await tx`
			insert into ${tx(table)}
			select * from jsonb_populate_recordset(null::${tx(table)}, ${batch}::text::jsonb)
		`;
	}
}

/**
 * Reads a stored version back in the release shape, so its hash is comparable with the files. Rows travel as JSON
 * text built by the database, for the same reason as in `insertRows`.
 */
async function readContent(tx: Executor, versionId: string): Promise<Record<keyof TaxonomyContent, unknown>> {
	const [version] = await tx<{ sources: string }[]>`
		select sources::text as sources from taxonomy_versions where id = ${versionId}
	`;
	const [strength] = await readRows(tx, 'fsp_strength_params', versionId);
	if (!version || !strength) throw new Error(`taxonomy version ${versionId} is incomplete`);
	const salary = await readRows(tx, 'salary_references', versionId);
	return {
		sources: JSON.parse(version.sources) as unknown,
		roles: await readRows(tx, 'roles', versionId),
		skills: await readRows(tx, 'skills', versionId),
		skillAliases: await readRows(tx, 'skill_aliases', versionId),
		grades: await readRows(tx, 'grades', versionId),
		workFormats: await readRows(tx, 'work_formats', versionId),
		fspProjectionRules: await readRows(tx, 'fsp_projection_rules', versionId),
		fspStrengthParams: strength,
		fspLevelRules: await readRows(tx, 'fsp_level_rules', versionId),
		receiptTemplates: await readRows(tx, 'receipt_templates', versionId),
		// `to_jsonb` writes a timestamp in the session time zone; the release keeps UTC ISO strings.
		salaryReferences: salary.map((row) => {
			if (typeof row.collected_at !== 'string') throw new Error('salary reference without collected_at');
			return { ...row, collected_at: new Date(row.collected_at).toISOString() };
		})
	};
}

/** Rows of a version without the version id and surrogate ids. */
async function readRows(tx: Executor, table: string, versionId: string): Promise<Record<string, unknown>[]> {
	const rows = await tx<{ row: string }[]>`
		select (to_jsonb(t) - 'taxonomy_version_id' - 'id')::text as row
		from ${tx(table)} t where t.taxonomy_version_id = ${versionId}
	`;
	return rows.map((r) => JSON.parse(r.row) as Record<string, unknown>);
}
