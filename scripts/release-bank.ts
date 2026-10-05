// Releases the bank of test items (docs/domain.md, 10.5) from the bank tree `assessments/families/` into the database
// from DATABASE_URL, like the product policies, on every start. For every specialization with families: the content
// hash of the descriptors and generators; the same content as the release in force — nothing to do; other content —
// a new release `<specialization>@<catalog>-<n>` that replaces the one in force, only if it has no problem
// (`releaseProblems` of the contract): every family passes its admission gates, generators produce valid instances, every
// extreme history is served (`capacityChecks`) and the engine's trajectory report meets `trajectoryAcceptance`. A bank with problems is not
// released and its specialization stays closed (`specializationOpen`); the problems are printed, defects apart from the
// judgements the bank still awaits (Angoff ratings, rubric reviews).
//
// The trajectory report is the one slow part (thousands of simulated attempts per grade). It is made by a separate
// command and stored next to the tree, `assessments/trajectories/<specialization>.json`, keyed by the content hash, the
// catalog and procedure versions and the hash of the simulation code; the report is seeded by the content, so the same
// key always gives the same report. A start never simulates: it takes the stored report of the current key and runs every
// other check, or, without one, leaves the specialization closed and says so.
//
// Modes:
//   (none)        the start: publish with stored reports only;
//   --simulate    publish, simulating and storing the reports that are missing (`pnpm db:release-bank`);
//   --check       no database: check the tree as release 1, simulating and storing missing reports, exit 1 on any
//                 problem or missing report (`pnpm bank:check`).
// Runs with plain Node.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { CATALOG, type SpecializationKey } from '../src/lib/server/assessments/contract/catalog.ts';
import { PROCEDURE } from '../src/lib/server/assessments/contract/procedure.ts';
import type { TrajectoryReport, ValidationProblem } from '../src/lib/server/assessments/contract/validate.ts';
import { loadBankTree, type LoadedBank } from '../src/lib/server/assessments/families.ts';
import { assembleRelease, releaseContentSha256 } from '../src/lib/server/assessments/release.ts';
import { simulationSha256 } from '../src/lib/server/assessments/simulation-key.ts';

export const BANK_TREE = fileURLToPath(new URL('../assessments/families', import.meta.url));
export const TRAJECTORY_DIR = fileURLToPath(new URL('../assessments/trajectories', import.meta.url));

export interface ReleaseOutcome {
	specialization: SpecializationKey;
	/** `unchecked` — no stored trajectory report for the current content: not released, the specialization stays closed. */
	outcome: 'released' | 'unchanged' | 'refused' | 'unchecked';
	id: string | null;
	problems: ValidationProblem[];
}

/** What a trajectory report was made of: the same key gives the same report. */
export interface TrajectoryKey {
	contentSha256: string;
	catalogVersion: string;
	procedureVersion: string;
	simulationSha256: string;
}

/** Where reports are kept, and whether a missing one is simulated now or leaves the bank unchecked. */
export interface TrajectoryStore {
	simulate: boolean;
	read(specialization: SpecializationKey, key: TrajectoryKey): Promise<TrajectoryReport | null>;
	write(specialization: SpecializationKey, key: TrajectoryKey, report: TrajectoryReport): Promise<void>;
}

interface StoredTrajectories {
	key: TrajectoryKey;
	report: TrajectoryReport;
}

const sameKey = (a: TrajectoryKey, b: TrajectoryKey): boolean =>
	a.contentSha256 === b.contentSha256 &&
	a.catalogVersion === b.catalogVersion &&
	a.procedureVersion === b.procedureVersion &&
	a.simulationSha256 === b.simulationSha256;

/** Reports as files of `dir`, one per specialization: the last one made, used only under its own key. */
export function fileTrajectoryStore(dir: string, simulate: boolean): TrajectoryStore {
	const path = (specialization: SpecializationKey) => join(dir, `${specialization}.json`);
	return {
		simulate,
		async read(specialization, key) {
			let text: string;
			try {
				text = await readFile(path(specialization), 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
				throw error;
			}
			const stored = JSON.parse(text) as StoredTrajectories;
			return sameKey(stored.key, key) ? stored.report : null;
		},
		async write(specialization, key, report) {
			await mkdir(dir, { recursive: true });
			const stored: StoredTrajectories = { key, report };
			await writeFile(path(specialization), `${JSON.stringify(stored, null, '\t')}\n`);
		}
	};
}

function trajectoryKey(bank: LoadedBank, simulation: string): TrajectoryKey {
	return {
		contentSha256: releaseContentSha256(
			bank.families.map((f) => ({ descriptor: f.descriptor, generatorSha256: f.generatorSha256 })),
			bank.sharedSha256
		),
		catalogVersion: CATALOG.version,
		procedureVersion: PROCEDURE.version,
		simulationSha256: simulation
	};
}

/**
 * The release of a bank as release `n` with the stored report of its key, or simulating one when the store allows (and
 * storing it); `null` — no report and no simulation.
 */
async function assembleWith(
	specialization: SpecializationKey,
	bank: LoadedBank,
	n: number,
	store: TrajectoryStore,
	simulation: string
) {
	const key = trajectoryKey(bank, simulation);
	const stored = await store.read(specialization, key);
	if (!stored && !store.simulate) return null;
	const assembled = assembleRelease(
		specialization,
		bank.families,
		bank.sharedSha256,
		n,
		stored ? { trajectories: stored } : {}
	);
	if (!stored && assembled.manifest.trajectories)
		await store.write(specialization, key, assembled.manifest.trajectories);
	return assembled;
}

/** Publishes the releases in one transaction under an advisory lock; concurrent starts publish once. */
export async function publishBankReleases(
	client: postgres.Sql,
	tree: ReadonlyMap<SpecializationKey, LoadedBank>,
	store: TrajectoryStore,
	now: Date = new Date()
): Promise<ReleaseOutcome[]> {
	const simulation = await simulationSha256();
	return client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended('bank.release', 0))`;
		const outcomes: ReleaseOutcome[] = [];
		for (const [specialization, bank] of tree) {
			const { contentSha256 } = trajectoryKey(bank, simulation);
			const [inForce] = await tx<{ id: string; content_sha256: string }[]>`
				select id, content_sha256 from bank_releases where specialization = ${specialization} and status = 'released'`;
			if (inForce?.content_sha256 === contentSha256) {
				outcomes.push({ specialization, outcome: 'unchanged', id: inForce.id, problems: [] });
				continue;
			}
			const [{ total } = { total: 0 }] = await tx<{ total: number }[]>`
				select count(*)::int as total from bank_releases where specialization = ${specialization}`;
			const assembled = await assembleWith(specialization, bank, total + 1, store, simulation);
			if (!assembled) {
				outcomes.push({ specialization, outcome: 'unchecked', id: null, problems: [] });
				continue;
			}
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
					${assembled.release.procedureVersion}, ${assembled.contentSha256}, ${bank.sharedSha256}, ${manifest}::text::jsonb,
					'released', ${now})`;
			outcomes.push({ specialization, outcome: 'released', id: assembled.release.id, problems: [] });
		}
		return outcomes;
	});
}

/** The tree checked without a database, each bank as release 1. */
export async function checkBankTree(
	tree: ReadonlyMap<SpecializationKey, LoadedBank>,
	store: TrajectoryStore
): Promise<ReleaseOutcome[]> {
	const simulation = await simulationSha256();
	const outcomes: ReleaseOutcome[] = [];
	for (const [specialization, bank] of tree) {
		const assembled = await assembleWith(specialization, bank, 1, store, simulation);
		if (!assembled) outcomes.push({ specialization, outcome: 'unchecked', id: null, problems: [] });
		else
			outcomes.push({
				specialization,
				outcome: assembled.problems.length > 0 ? 'refused' : 'unchanged',
				id: null,
				problems: assembled.problems
			});
	}
	return outcomes;
}

function report(outcomes: readonly ReleaseOutcome[]): void {
	if (outcomes.length === 0) console.log('Bank releases: no families in the bank tree');
	for (const outcome of outcomes) {
		console.log(`Bank release ${outcome.specialization}: ${outcome.outcome}${outcome.id ? ` ${outcome.id}` : ''}`);
		if (outcome.outcome === 'unchecked') {
			console.error(
				`  no trajectory report for the current content of the bank — the specialization stays closed; ` +
					`run \`pnpm bank:check\` and commit assessments/trajectories/${outcome.specialization}.json`
			);
		}
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
		const outcomes = await checkBankTree(tree, fileTrajectoryStore(TRAJECTORY_DIR, true));
		report(outcomes);
		if (outcomes.some((o) => o.outcome !== 'unchanged')) process.exitCode = 1;
	} else {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) throw new Error('DATABASE_URL is not set');
		const client = postgres(databaseUrl, { max: 1 });
		try {
			const store = fileTrajectoryStore(TRAJECTORY_DIR, process.argv.includes('--simulate'));
			report(await publishBankReleases(client, tree, store));
		} finally {
			await client.end({ timeout: 5 });
		}
	}
}
