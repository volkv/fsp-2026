// Releases the bank of test items (docs/domain.md, 10.5) from the bank tree `assessments/families/` into the database
// from DATABASE_URL, like the product policies, on every start. For every specialization with families: the content
// hash of the descriptors and generators; the same content as the release in force — nothing to do; other content —
// a new release `<specialization>@<catalog>-<n>` that replaces the one in force, only if it has no problem
// (`releaseProblems` of the contract): every family passes its admission gates, generators produce valid instances, every
// extreme history is served (`capacityChecks`) and the engine's trajectory report meets `trajectoryAcceptance`. A bank with problems is not
// released and its specialization stays closed (`specializationOpen`); the problems are printed, defects apart from the
// judgements the bank still awaits (Angoff ratings, rubric reviews).
//
// `--check` only checks the tree and exits with 1 on any problem, without a database. Runs with plain Node.
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadBankTree, type LoadedBank } from '../src/lib/server/assessments/families.ts';
import { assembleRelease, releaseContentSha256 } from '../src/lib/server/assessments/release.ts';
import type { SpecializationKey } from '../src/lib/server/assessments/contract/catalog.ts';
import type { ValidationProblem } from '../src/lib/server/assessments/contract/validate.ts';

export const BANK_TREE = fileURLToPath(new URL('../assessments/families', import.meta.url));

export interface ReleaseOutcome {
	specialization: SpecializationKey;
	outcome: 'released' | 'unchanged' | 'refused';
	id: string | null;
	problems: ValidationProblem[];
}

/** Publishes the releases in one transaction under an advisory lock; concurrent starts publish once. */
export async function publishBankReleases(
	client: postgres.Sql,
	tree: ReadonlyMap<SpecializationKey, LoadedBank>,
	now: Date = new Date()
): Promise<ReleaseOutcome[]> {
	return client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended('bank.release', 0))`;
		const outcomes: ReleaseOutcome[] = [];
		for (const [specialization, { families, sharedSha256 }] of tree) {
			const content = releaseContentSha256(
				families.map((f) => ({ descriptor: f.descriptor, generatorSha256: f.generatorSha256 })),
				sharedSha256
			);
			const [inForce] = await tx<{ id: string; content_sha256: string }[]>`
				select id, content_sha256 from bank_releases where specialization = ${specialization} and status = 'released'`;
			if (inForce?.content_sha256 === content) {
				outcomes.push({ specialization, outcome: 'unchanged', id: inForce.id, problems: [] });
				continue;
			}
			const [{ total } = { total: 0 }] = await tx<{ total: number }[]>`
				select count(*)::int as total from bank_releases where specialization = ${specialization}`;
			const assembled = assembleRelease(specialization, families, sharedSha256, total + 1);
			if (assembled.problems.length > 0) {
				outcomes.push({ specialization, outcome: 'refused', id: null, problems: assembled.problems });
				continue;
			}
			const manifest = JSON.stringify(assembled.manifest);
			if (inForce) {
				await tx`update bank_releases set status = 'retired', retired_at = ${now} where id = ${inForce.id}`;
			}
			await tx`
				insert into bank_releases (id, specialization, catalog_version, procedure_version, content_sha256, shared_sha256,
					manifest, status, released_at)
				values (${assembled.release.id}, ${specialization}, ${assembled.release.catalogVersion},
					${assembled.release.procedureVersion}, ${assembled.contentSha256}, ${sharedSha256}, ${manifest}::text::jsonb,
					'released', ${now})`;
			outcomes.push({ specialization, outcome: 'released', id: assembled.release.id, problems: [] });
		}
		return outcomes;
	});
}

function report(outcomes: readonly ReleaseOutcome[]): void {
	if (outcomes.length === 0) console.log('Bank releases: no families in the bank tree');
	for (const outcome of outcomes) {
		console.log(`Bank release ${outcome.specialization}: ${outcome.outcome}${outcome.id ? ` ${outcome.id}` : ''}`);
		const defects = outcome.problems.filter((p) => p.code === 'defect');
		const awaiting = outcome.problems.filter((p) => p.code !== 'defect');
		if (defects.length > 0) console.error(`  defects (${defects.length}):`);
		for (const problem of defects) console.error(`    ${problem.message}`);
		if (awaiting.length > 0) console.error(`  awaiting judgements (${awaiting.length}):`);
		for (const problem of awaiting) console.error(`    ${problem.code}: ${problem.message}`);
	}
}

if (import.meta.main) {
	const tree = await loadBankTree(BANK_TREE);
	if (process.argv.includes('--check')) {
		const outcomes: ReleaseOutcome[] = [...tree].map(([specialization, { families, sharedSha256 }]) => {
			const { problems } = assembleRelease(specialization, families, sharedSha256, 1);
			return { specialization, outcome: problems.length > 0 ? 'refused' : 'unchanged', id: null, problems };
		});
		report(outcomes);
		if (outcomes.some((o) => o.problems.length > 0)) process.exitCode = 1;
	} else {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) throw new Error('DATABASE_URL is not set');
		const client = postgres(databaseUrl, { max: 1 });
		try {
			report(await publishBankReleases(client, tree));
		} finally {
			await client.end({ timeout: 5 });
		}
	}
}
