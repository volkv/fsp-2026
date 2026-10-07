// The release of the bank against the database when something is wrong (docs/domain.md, 10.5): one specialization's
// broken bank refuses that bank only, a release in force whose code left the tree is withdrawn and its specialization
// closed until a release passes, a family without a passed gate run on its current source keeps the bank out, and the
// attempts still running on a release whose code left the tree are annulled for `version_defect` at the start.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { annulStaleAttempts, countsAsAttempt } from '$lib/server/assessments/annul';
import { releasedSpecializations } from '$lib/server/assessments/bank-store';
import { CATALOG, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { PROCEDURE } from '$lib/server/assessments/contract/procedure';
import {
	loadSpecializationFamilies,
	sharedCodeSha256,
	type BankLoad,
	type LoadedFamily
} from '$lib/server/assessments/families';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { auditEvents, bankReleases, notifications, testAttempts } from '$lib/server/db/schema';
import {
	checkBankTree,
	fileTrajectoryStore,
	publishBankReleases,
	type TrajectoryStore
} from '../../scripts/release-bank';
import { insertAttempt } from '../helpers/bank';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate } from '../helpers/factories';
import { fixtureFamilies } from '../helpers/families';

const V = CATALOG.version;
const SHARED = '0'.repeat(64);
const FIXTURE_TREE = fileURLToPath(new URL('../fixtures/families', import.meta.url));

let database: TestDatabase;
let client: postgres.Sql;
let dir: string;
let atStart: TrajectoryStore;
let simulating: TrajectoryStore;

const loaded = (families: LoadedFamily[], sharedSha256 = SHARED) => ({
	ok: true as const,
	bank: { families, sharedSha256 }
});

/** A fixture bank whose generators throw on any seed but the release's samples: the simulation of the bank throws. */
function throwingInSimulation(specialization: SpecializationKey): LoadedFamily[] {
	return fixtureFamilies(specialization).map((f, i) =>
		i === 0
			? {
					...f,
					module: {
						generate: (input: Parameters<typeof f.module.generate>[0]) => {
							if (!input.seed.startsWith('release-sample-')) throw new Error('the generator broke');
							return f.module.generate(input);
						}
					}
				}
			: f
	);
}

const statusOf = async (id: string) =>
	(await database.db.select({ status: bankReleases.status }).from(bankReleases).where(eq(bankReleases.id, id)))[0]
		?.status;

beforeAll(async () => {
	database = await createTestDatabase();
	client = postgres(database.url, { max: 1, onnotice: () => {} });
	dir = await mkdtemp(join(tmpdir(), 'trajectories-'));
	atStart = fileTrajectoryStore(dir, false);
	simulating = fileTrajectoryStore(dir, true);
});

afterAll(async () => {
	await client.end({ timeout: 5 });
	await rm(dir, { recursive: true, force: true });
	await database.drop();
});

describe('a broken specialization', () => {
	it('refuses only its own bank: the others are released, the check names each one', async () => {
		const mobile = fixtureFamilies('mobile');
		const tree = new Map<SpecializationKey, BankLoad>([
			['mobile', loaded(mobile)],
			['devops', loaded(throwingInSimulation('devops'))],
			['qa', { ok: false, error: 'qa/qa.x: the descriptor names qa/qa.y' }]
		]);
		const outcomes = await publishBankReleases(client, tree, simulating);
		expect(outcomes).toEqual([
			{ specialization: 'mobile', outcome: 'released', id: `mobile@${V}-1`, problems: [], withdrawn: null },
			{
				specialization: 'devops',
				outcome: 'refused',
				id: null,
				problems: [{ code: 'defect', message: 'the check of the bank failed: the generator broke' }],
				withdrawn: null
			},
			{
				specialization: 'qa',
				outcome: 'refused',
				id: null,
				problems: [{ code: 'defect', message: 'the bank tree does not load: qa/qa.x: the descriptor names qa/qa.y' }],
				withdrawn: null
			}
		]);
		expect(await releasedSpecializations(database.db)).toEqual(new Set(['mobile']));
		// The check without a database: the same verdict for each specialization on its own.
		expect((await checkBankTree(tree, simulating)).map((o) => [o.specialization, o.outcome])).toEqual([
			['mobile', 'unchanged'],
			['devops', 'refused'],
			['qa', 'refused']
		]);
	}, 180_000);
});

describe('a refused bank with a release in force', () => {
	it('keeps the release while the tree runs its code, withdraws it once the generators changed, until a release passes', async () => {
		const mobile = fixtureFamilies('mobile');
		const tree = (families: LoadedFamily[]) => new Map([['mobile' as const, loaded(families)]]);
		// The descriptors changed, the generators did not: the new content waits for its report, the release in force
		// still runs on the tree and serves.
		const described = mobile.map((f, i) =>
			i === 0 ? { ...f, descriptor: { ...f.descriptor, version: f.descriptor.version + 1 } } : f
		);
		expect(await publishBankReleases(client, tree(described), atStart)).toEqual([
			{ specialization: 'mobile', outcome: 'unchecked', id: null, problems: [], withdrawn: null }
		]);
		expect(await statusOf(`mobile@${V}-1`)).toBe('released');
		// A generator changed and the new bank is not released: the release in force is not the code on disk any more.
		const changed = mobile.map((f, i) => (i === 0 ? { ...f, generatorSha256: 'f'.repeat(64) } : f));
		expect(await publishBankReleases(client, tree(changed), atStart)).toEqual([
			{ specialization: 'mobile', outcome: 'unchecked', id: null, problems: [], withdrawn: `mobile@${V}-1` }
		]);
		expect(await statusOf(`mobile@${V}-1`)).toBe('retired');
		expect((await releasedSpecializations(database.db)).has('mobile')).toBe(false);
		// The bank fixed: a new release, the specialization open again.
		expect(await publishBankReleases(client, tree(mobile), atStart)).toMatchObject([
			{ outcome: 'released', id: `mobile@${V}-2`, withdrawn: null }
		]);
		expect((await releasedSpecializations(database.db)).has('mobile')).toBe(true);
	}, 60_000);
});

describe('the gates of the families', () => {
	it('keep out a bank with a family whose gate run is not for its source, and withdraw the release in force of it', async () => {
		const devops = fixtureFamilies('devops');
		const tree = (families: LoadedFamily[]) => new Map([['devops' as const, loaded(families)]]);
		const ungated = devops.map((f, i) => (i === 0 ? { ...f, gate: { ...f.gate, recorded: null } } : f));
		const key = devops[0]?.descriptor.key;
		expect(await publishBankReleases(client, tree(ungated), simulating)).toEqual([
			{
				specialization: 'devops',
				outcome: 'refused',
				id: null,
				problems: [
					{
						code: 'defect',
						message: `family ${key}: no passed gate run in gate-sources.json (the gates failed or never ran)`
					}
				],
				withdrawn: null
			}
		]);
		expect(await publishBankReleases(client, tree(devops), simulating)).toMatchObject([
			{ outcome: 'released', id: `devops@${V}-1` }
		]);
		// The same content, but its gate run failed since: the bank in force is not released any more.
		const stale = devops.map((f, i) => (i === 0 ? { ...f, gate: { ...f.gate, recorded: '0'.repeat(64) } } : f));
		expect(await publishBankReleases(client, tree(stale), atStart)).toEqual([
			{
				specialization: 'devops',
				outcome: 'refused',
				id: null,
				problems: [
					{
						code: 'defect',
						message: `family ${key}: the gate run in gate-sources.json is not for the current source (run the gates again)`
					}
				],
				withdrawn: `devops@${V}-1`
			}
		]);
		expect(await statusOf(`devops@${V}-1`)).toBe('retired');
	}, 180_000);
});

describe('attempts on a release whose code left the tree', () => {
	it('are annulled for version_defect at the start, a free retake, the candidate notified; others go on', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bank-tree-'));
		try {
			await cp(FIXTURE_TREE, root, { recursive: true });
			const families = await loadSpecializationFamilies(root, 'backend');
			const manifest = {
				families: families.map((f) => ({ descriptor: f.descriptor, generatorSha256: f.generatorSha256 }))
			};
			const releaseId = `backend@${V}-1`;
			await database.db.insert(bankReleases).values({
				id: releaseId,
				specialization: 'backend',
				catalogVersion: V,
				procedureVersion: PROCEDURE.version,
				contentSha256: 'a'.repeat(64),
				sharedSha256: await sharedCodeSha256(root, 'backend'),
				manifest,
				status: 'released',
				releasedAt: new Date()
			});
			const candidate = await createCandidate(database.db);
			const running = await insertAttempt(database.db, { candidateId: candidate.id, releaseId, status: 'in_progress' });

			// The tree runs the release's code: nothing to annul.
			expect(await annulStaleAttempts(database.db, OWNER_STANDING, new Date(), root)).toEqual([]);

			const generator = join(root, 'backend', 'be.lang.fixture-sum', 'generator.ts');
			await writeFile(generator, `${await readFile(generator, 'utf8')}\n// the next version\n`);
			const now = new Date();
			expect(await annulStaleAttempts(database.db, OWNER_STANDING, now, root)).toEqual([
				{
					releaseId,
					drift: ['the generator of be.lang.fixture-sum changed'],
					annulled: [running.id]
				}
			]);
			const [attempt] = await database.db.select().from(testAttempts).where(eq(testAttempts.id, running.id));
			expect(attempt).toMatchObject({ status: 'annulled', annulReason: 'version_defect', annulledBy: null });
			expect(attempt?.endedAt).toEqual(now);
			expect(countsAsAttempt('version_defect')).toBe(false);
			const [notice] = await database.db
				.select({ payload: notifications.payload })
				.from(notifications)
				.where(and(eq(notifications.userId, candidate.userId), eq(notifications.type, 'assessment.annulled')));
			expect(notice?.payload).toEqual({ attempt_id: running.id, reason: 'version_defect' });
			const [event] = await database.db
				.select({ actorKind: auditEvents.actorKind, details: auditEvents.details })
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'assessment.annulled'), eq(auditEvents.objectId, running.id)));
			expect(event).toEqual({
				actorKind: 'system',
				details: { reason: 'version_defect', previous_status: 'in_progress' }
			});
			// Once annulled, a second start has nothing left to do.
			expect(await annulStaleAttempts(database.db, OWNER_STANDING, new Date(), root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
