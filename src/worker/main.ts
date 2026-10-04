// Entry point of the background worker process (`node build/worker/main.js --types …`): runs the enabled job types
// until SIGTERM or SIGINT, then stops gracefully and exits. Built by bundle.config.ts next to this file.
import { closeDb, db } from '$lib/server/db';
import { JOB_HANDLERS, SCHEDULE_TICKS } from '$lib/server/jobs/handlers';
import { createLogger } from '$lib/server/jobs/log';
import { startWorker } from '$lib/server/jobs/worker';
import { closeRedis } from '$lib/server/redis';
import { parseWorkerArgs } from './args';
import { serveHealth } from './health';

const log = createLogger({ component: 'worker' });

/**
 * How long a stop after an uncaught error may take beyond the grace period: the wait for aborted handlers and the
 * lease writes. A signal has Docker's `stop_grace_period` as its limit; an uncaught error has none but this one.
 */
const FATAL_STOP_MARGIN_MS = 30_000;
/** Grace period of running jobs on a stop, unless `--shutdown-grace-ms` sets another. */
const DEFAULT_GRACE_MS = 20_000;

async function main(): Promise<void> {
	const args = parseWorkerArgs(process.argv.slice(2));
	const graceMs = args.shutdownGraceMs ?? DEFAULT_GRACE_MS;
	log.info('worker process starting', { version: __APP_VERSION__, commit: __APP_COMMIT__ });
	const worker = startWorker({
		db: db(),
		handlers: JOB_HANDLERS,
		ticks: SCHEDULE_TICKS,
		types: args.types,
		concurrency: args.concurrency,
		shutdownGraceMs: graceMs,
		log
	});
	const health = args.healthPort === null ? null : await serveHealth(worker, args.healthPort);
	if (health) log.info('state endpoint listening', { url: `http://127.0.0.1:${args.healthPort}/health` });

	let exitCode = 0;
	let stopping: Promise<void> | undefined;
	const stop = () => {
		stopping ??= worker
			.stop()
			.then(async () => {
				health?.close();
				closeRedis();
				await closeDb();
				process.exit(exitCode);
			})
			.catch((error: unknown) => {
				log.error('worker did not stop cleanly', {}, error);
				process.exit(1);
			});
	};

	const onSignal = (signal: NodeJS.Signals) => {
		if (stopping) {
			log.warn('second signal while stopping; still waiting for running jobs', { signal });
			return;
		}
		log.info('signal received', { signal });
		stop();
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);

	// An exception nobody caught (thrown from a callback or a timer, or a rejection without a handler — Node reports
	// both here) leaves the process in an unknown state, and dying on the spot keeps the leases of the running jobs until
	// they expire, up to 30 minutes. The worker stops as on a signal instead — capture ends, running jobs get the grace
	// period, the remaining leases are given back — and exits with 1, so that Docker starts it again. Known source: a
	// broken database connection inside a transaction, where postgres.js writes the ROLLBACK to the closed socket from
	// a timer (docs/deploy.md, «Обрыв соединения с базой»).
	process.on('uncaughtException', (error, origin) => {
		exitCode = 1;
		log.error('uncaught error, stopping the worker', { origin }, error);
		if (stopping) return;
		stop();
		const limitMs = graceMs + FATAL_STOP_MARGIN_MS;
		setTimeout(() => {
			log.error('worker did not stop in time after an uncaught error', { limit_ms: limitMs });
			process.exit(1);
		}, limitMs).unref();
	});
}

main().catch((error: unknown) => {
	log.error('worker failed to start', {}, error);
	process.exit(1);
});
