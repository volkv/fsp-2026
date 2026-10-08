// Command line of the demo stand (`node build/demo/main.js <command>`, built by bundle.config.ts next to this file):
//   seed         — seed the demo data of the current batch; nothing to do when it is seeded;
//   reset        — empty the stand except the reference data, then seed it again (`--no-seed` only empties it);
//                  a seed enqueues `embedding.reindex` of the spaces search needs, as the job `demo.reset` does;
//   ensure       — at the start of the application: when the current batch is not seeded, enqueue `demo.reset` for the
//                  worker (the seed takes minutes, longer than a deployment waits for the application to be healthy).
// Every command refuses outside demonstration mode (DEMO_MODE=true).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { closeDb } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { enqueueJob } from '$lib/server/jobs/queue';
import { closeRedis } from '$lib/server/redis';
import { configuredDemoServices } from './configured';
import { readSeedData } from './data';
import { enqueueDemoReindex } from './job';
import { resetDemo } from './reset';
import { batchId, isSeeded, publishedReconsents, releasedBanks, seedDemo } from './seed';
import type { DemoServices } from './services';

const log = createLogger({ component: 'demo' });

async function seed(services: DemoServices): Promise<void> {
	const summary = await seedDemo(services);
	log.info(summary.status === 'seeded' ? 'demo data seeded' : 'demo data already seeded', {
		batch: summary.batch,
		duration_ms: summary.durationMs,
		...Object.fromEntries(
			Object.entries(summary.counts).map(([key, value]) => [
				key,
				typeof value === 'number' ? value : JSON.stringify(value)
			])
		),
		...(summary.tests === null ? {} : { tests: JSON.stringify(summary.tests) })
	});
	if (summary.status !== 'seeded') return;
	// The reset emptied the vectors of profiles and vacancies; the fresh seed gets them back (job.ts).
	const spaces = await enqueueDemoReindex(services.db);
	log.info('embedding reindex enqueued after the demo seed', { spaces: spaces.join(',') });
}

async function reset(services: DemoServices, withSeed: boolean): Promise<void> {
	const summary = await resetDemo(
		{
			db: services.db,
			redis: services.redis,
			store: services.store,
			fspMock: { origin: services.fspMockOrigin, controlToken: services.settings.fspMockControlToken }
		},
		{ requestId: 'demo-cli:reset', trigger: 'manual' }
	);
	log.info('demo stand reset', {
		tables_cleared: summary.tablesCleared,
		rows_kept: summary.rowsKept,
		files_removed: summary.filesRemoved
	});
	if (withSeed) await seed(services);
}

async function ensure(services: DemoServices): Promise<void> {
	const batch = batchId(
		await readSeedData(services.seedsDir),
		services.settings,
		await releasedBanks(services),
		await publishedReconsents(services)
	);
	if (await isSeeded(services, batch)) {
		log.info('demo data of the current batch are seeded', { batch });
		return;
	}
	const date = new Date().toISOString().slice(0, 10);
	const enqueued = await services.db.transaction(async (tx) => {
		// Only a reset asked for at start counts: the job of a night waits for 00:00 UTC, and with `DEMO_NIGHTLY_RESET`
		// turned off since it was enqueued it resets nothing.
		const [pending] = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.type, 'demo.reset'),
					inArray(jobs.status, ['queued', 'running']),
					sql`${jobs.payload}->>'kind' = 'startup'`
				)
			)
			.limit(1);
		if (pending) return false;
		await enqueueJob(
			tx,
			'demo.reset',
			{ kind: 'startup', date },
			{ inputVersion: batch, createdBy: { kind: 'system', id: 'demo-ensure' } }
		);
		return true;
	});
	log.info(enqueued ? 'demo reset enqueued for the worker' : 'demo reset is already waiting for the worker', { batch });
}

async function main(): Promise<void> {
	const [command, ...flags] = process.argv.slice(2);
	const services = await configuredDemoServices(log);
	switch (command) {
		case 'seed':
			await seed(services);
			return;
		case 'reset':
			await reset(services, !flags.includes('--no-seed'));
			return;
		case 'ensure':
			await ensure(services);
			return;
		default:
			throw new Error(`unknown command «${command ?? ''}»: seed, reset [--no-seed] or ensure`);
	}
}

main()
	.then(async () => {
		closeRedis();
		await closeDb();
	})
	.catch(async (error: unknown) => {
		log.error('demo command failed', {}, error);
		closeRedis();
		await closeDb();
		process.exitCode = 1;
	});
