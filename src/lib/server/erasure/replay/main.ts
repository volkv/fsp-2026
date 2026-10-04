// Command line of the erasure ledger (`node build/erasure/main.js <command>`, built by bundle.config.ts next to this
// file), for a restore from a backup (docs/deploy.md, «Бэкап и восстановление»; ledger.ts):
//   export — before the restore, from the live database: the ledger to stdout, one JSON object per line;
//   replay — after the restore: the export from stdin applied to the restored database. Accounts it cannot delete are
//            named in the log and the command exits with 1; the others are erased all the same.
import { closeDb, db } from '$lib/server/db';
import { createLogger } from '$lib/server/jobs/log';
import { closeRedis, redis } from '$lib/server/redis';
import { objectStore } from '$lib/server/storage/object-store';
import { exportLedger, formatLedger, parseLedger, replayLedger } from './ledger';

const log = createLogger({ component: 'erasure-ledger' });

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

/** The export goes to stdout alone, so that it can be redirected to a file; the count goes to stderr. */
async function runExport(): Promise<void> {
	const entries = await exportLedger(db());
	process.stdout.write(formatLedger(entries));
	process.stderr.write(`erasure ledger exported: ${entries.length} entries\n`);
}

async function runReplay(): Promise<void> {
	const entries = parseLedger(await readStdin());
	const summary = await replayLedger(
		{ db: db(), redis: await redis(), store: objectStore(), now: () => new Date() },
		entries,
		'erasure-cli:replay'
	);
	for (const refusal of summary.refused) {
		log.error('erasure ledger entry refused: the account is left as restored', {
			user_id: refusal.userId,
			reason: refusal.reason,
			...(refusal.companyName === undefined ? {} : { company: refusal.companyName })
		});
	}
	log.info('erasure ledger replayed', {
		entries: summary.entries,
		...summary.outcomes,
		refused: summary.refused.length
	});
	if (summary.refused.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	if (rest.length > 0) throw new Error(`unexpected arguments: ${rest.join(' ')}`);
	if (command === 'export') await runExport();
	else if (command === 'replay') await runReplay();
	else throw new Error(`unknown command «${command ?? ''}»: export or replay`);
}

main()
	.then(async () => {
		closeRedis();
		await closeDb();
	})
	.catch(async (error: unknown) => {
		log.error('erasure ledger command failed', {}, error);
		closeRedis();
		await closeDb();
		process.exitCode = 1;
	});
