// Releases the bank of test items (docs/domain.md, 10.5) from the bank tree `assessments/families/` into the database
// from DATABASE_URL, like the product policies, on every start. For every specialization with families: the content
// hash of the descriptors and generators; the same content as the release in force — nothing to do while every family
// still has its passed gate run; other content — a new release `<specialization>@<catalog>-<n>` that replaces the one in
// force, only if it has no problem: every family has a passed gate run on its current source (`gate-sources.json`) and
// passes the contract's validator, generators produce valid instances, every extreme history is served
// (`capacityChecks`) and the engine's trajectory report meets `trajectoryAcceptance`. A bank with problems is not
// released; the problems are printed, defects apart from the judgements the bank still awaits (Angoff ratings, rubric
// reviews).
//
// Every specialization stands alone: a bank that does not load or whose generators throw during the checks is refused
// with the error as its defect, and the others are released. A refused bank keeps its release in force only while the
// tree still runs that release's code (only descriptors changed) and its families pass their gates; otherwise the
// release is withdrawn (`retired`) and the specialization is closed (`specializationOpen`) until a release passes. The
// start goes on either way: one specialization never stops the application.
//
// The trajectory report is the one slow part (thousands of simulated attempts per grade). It is made by a separate
// command and stored next to the tree, `assessments/trajectories/<specialization>.json`, keyed by the content hash, the
// catalog and procedure versions and the hash of the simulation code; the report is seeded by the content, so the same
// key always gives the same report. A start never simulates: it takes the stored report of the current key and runs every
// other check, or, without one, does not release the new content (`unchecked`) and says so.
//
// Modes:
//   (none)        the start: publish with stored reports only;
//   --simulate    publish, simulating and storing the reports that are missing (`pnpm db:release-bank`);
//   --check       no database: check every specialization of the tree as release 1, on its own, simulating and
//                 storing missing reports; a line per specialization at the end, exit 1 if any is refused or
//                 unchecked (`pnpm bank:check`); `--specialization <key>` checks that one only.
// Runs with plain Node.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { CATALOG, type SpecializationKey } from '../src/lib/server/assessments/contract/catalog.ts';
import { PROCEDURE } from '../src/lib/server/assessments/contract/procedure.ts';
import type { TrajectoryReport, ValidationProblem } from '../src/lib/server/assessments/contract/validate.ts';
import {
	codeDrift,
	errorMessage,
	loadBankTree,
	loadedBankCode,
	type BankLoad,
	type LoadedBank
} from '../src/lib/server/assessments/families.ts';
import {
	assembleRelease,
	gateRecordProblems,
	releaseContentSha256,
	type AssembledRelease,
	type ManifestFamily
} from '../src/lib/server/assessments/release.ts';
import { simulationSha256 } from '../src/lib/server/assessments/simulation-key.ts';

export const BANK_TREE = fileURLToPath(new URL('../assessments/families', import.meta.url));
export const TRAJECTORY_DIR = fileURLToPath(new URL('../assessments/trajectories', import.meta.url));

export interface ReleaseOutcome {
	specialization: SpecializationKey;
	/** `unchecked` — no stored trajectory report for the current content: not released, the specialization stays closed. */
	outcome: 'released' | 'unchanged' | 'refused' | 'unchecked';
	id: string | null;
	problems: ValidationProblem[];
	/** The release in force this refusal closed: the bank on disk no longer runs its code or passes its gates. */
	withdrawn: string | null;
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

interface InForce {
	id: string;
	content_sha256: string;
	shared_sha256: string;
	families: ManifestFamily[];
}

const failed = (specialization: SpecializationKey, what: string, error: unknown): ReleaseOutcome => ({
	specialization,
	outcome: 'refused',
	id: null,
	problems: [{ code: 'defect', message: `${what}: ${errorMessage(error)}` }],
	withdrawn: null
});

/**
 * The release of one specialization's bank as release `n`, or why not; an exception of its generators or of its
 * checks refuses this bank only, with the error as its defect.
 */
async function checkBank(
	specialization: SpecializationKey,
	load: BankLoad,
	n: number,
	store: TrajectoryStore,
	simulation: string
): Promise<{ outcome: ReleaseOutcome; assembled: AssembledRelease | null }> {
	if (!load.ok) return { outcome: failed(specialization, 'the bank tree does not load', load.error), assembled: null };
	let assembled: AssembledRelease | null;
	try {
		assembled = await assembleWith(specialization, load.bank, n, store, simulation);
	} catch (error) {
		return { outcome: failed(specialization, 'the check of the bank failed', error), assembled: null };
	}
	if (!assembled)
		return { outcome: { specialization, outcome: 'unchecked', id: null, problems: [], withdrawn: null }, assembled };
	const outcome: ReleaseOutcome['outcome'] = assembled.problems.length > 0 ? 'refused' : 'released';
	return {
		outcome: { specialization, outcome, id: null, problems: assembled.problems, withdrawn: null },
		assembled
	};
}

/**
 * Publishes the releases in one transaction under an advisory lock; concurrent starts publish once. Every
 * specialization is released on its own: one that is refused or unchecked leaves the others to go on. Its release in
 * force stays only while the bank on disk still runs that release's code (the new content changed descriptors only) and
 * passes the gates; otherwise it is withdrawn (`retired`) and the specialization is closed until a release passes —
 * the engine never serves a release whose generators are not on disk.
 */
export async function publishBankReleases(
	client: postgres.Sql,
	tree: ReadonlyMap<SpecializationKey, BankLoad>,
	store: TrajectoryStore,
	now: Date = new Date()
): Promise<ReleaseOutcome[]> {
	const simulation = await simulationSha256();
	return client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended('bank.release', 0))`;
		const outcomes: ReleaseOutcome[] = [];
		for (const [specialization, load] of tree) {
			const [inForce] = await tx<InForce[]>`
				select id, content_sha256, shared_sha256, manifest->'families' as families
				from bank_releases where specialization = ${specialization} and status = 'released'`;
			const withdraw = async (outcome: ReleaseOutcome): Promise<void> => {
				if (inForce) {
					await tx`update bank_releases set status = 'retired', retired_at = ${now} where id = ${inForce.id}`;
					outcome.withdrawn = inForce.id;
				}
				outcomes.push(outcome);
			};
			if (load.ok && inForce?.content_sha256 === trajectoryKey(load.bank, simulation).contentSha256) {
				// The content in force; the gates are read anew, since a failed gate run does not change the content.
				const gates = load.bank.families.flatMap(gateRecordProblems);
				if (gates.length === 0)
					outcomes.push({ specialization, outcome: 'unchanged', id: inForce.id, problems: [], withdrawn: null });
				else await withdraw({ specialization, outcome: 'refused', id: null, problems: gates, withdrawn: null });
				continue;
			}
			const [{ total } = { total: 0 }] = await tx<{ total: number }[]>`
				select count(*)::int as total from bank_releases where specialization = ${specialization}`;
			const { outcome, assembled } = await checkBank(specialization, load, total + 1, store, simulation);
			if (outcome.outcome !== 'released' || !assembled) {
				const serves =
					inForce !== undefined &&
					load.ok &&
					codeDrift({ families: inForce.families, sharedSha256: inForce.shared_sha256 }, loadedBankCode(load.bank))
						.length === 0;
				if (serves) outcomes.push(outcome);
				else await withdraw(outcome);
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
					${assembled.release.procedureVersion}, ${assembled.contentSha256}, ${assembled.release.sharedSha256},
					${manifest}::text::jsonb, 'released', ${now})`;
			outcomes.push({ ...outcome, id: assembled.release.id });
		}
		return outcomes;
	});
}

/** The tree checked without a database, each bank as release 1 and on its own: `unchanged` — it would be released. */
export async function checkBankTree(
	tree: ReadonlyMap<SpecializationKey, BankLoad>,
	store: TrajectoryStore
): Promise<ReleaseOutcome[]> {
	const simulation = await simulationSha256();
	const outcomes: ReleaseOutcome[] = [];
	for (const [specialization, load] of tree) {
		const { outcome } = await checkBank(specialization, load, 1, store, simulation);
		outcomes.push(outcome.outcome === 'released' ? { ...outcome, outcome: 'unchanged' } : outcome);
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
		if (outcome.withdrawn) {
			console.error(
				`  release ${outcome.withdrawn} withdrawn: the bank on disk no longer runs its code or passes its gates — ` +
					`the specialization is closed until a release passes`
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

/** One line per specialization after the details: what the check says of each. */
function summary(outcomes: readonly ReleaseOutcome[]): void {
	console.log('Bank check:');
	for (const outcome of outcomes) {
		const defects = outcome.problems.filter((p) => p.code === 'defect').length;
		const awaiting = outcome.problems.length - defects;
		const verdict =
			outcome.outcome === 'unchanged'
				? 'passes'
				: outcome.outcome === 'unchecked'
					? 'unchecked: no trajectory report'
					: `refused: ${defects} defects, ${awaiting} awaiting judgements`;
		console.log(`  ${outcome.specialization}: ${verdict}`);
	}
}

if (import.meta.main) {
	const { values: args } = parseArgs({
		options: {
			check: { type: 'boolean', default: false },
			simulate: { type: 'boolean', default: false },
			specialization: { type: 'string' }
		}
	});
	const tree = await loadBankTree(BANK_TREE);
	if (args.check) {
		const only = args.specialization;
		if (only !== undefined && !tree.has(only as SpecializationKey)) {
			throw new Error(`--specialization ${only}: the bank tree has no families of it`);
		}
		const checked = only === undefined ? tree : new Map([...tree].filter(([s]) => s === only));
		const outcomes = await checkBankTree(checked, fileTrajectoryStore(TRAJECTORY_DIR, true));
		report(outcomes);
		summary(outcomes);
		if (outcomes.some((o) => o.outcome !== 'unchanged')) process.exitCode = 1;
	} else {
		if (args.specialization !== undefined) throw new Error('--specialization applies to --check only');
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) throw new Error('DATABASE_URL is not set');
		const client = postgres(databaseUrl, { max: 1 });
		try {
			const store = fileTrajectoryStore(TRAJECTORY_DIR, args.simulate);
			report(await publishBankReleases(client, tree, store));
		} finally {
			await client.end({ timeout: 5 });
		}
	}
}
