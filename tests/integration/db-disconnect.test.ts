// A database connection that breaks under the worker process (the server restarted, the backend was killed) loses no
// job: the job whose transaction broke goes back to the queue at once instead of waiting out its lease in a dead
// process. The worker runs as a real process built from src/worker/main.ts, because the known failure is an exception
// from a timer of postgres.js — the ROLLBACK of the broken transaction written to the closed socket — which nothing in
// the worker's code can catch and which only the process level sees.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq, getTableName, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { invitationTerms, jobs } from '$lib/server/db/schema';
import { enqueueJob } from '$lib/server/jobs/queue';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Inside node_modules, so that the bundle's external dependencies resolve from the project's node_modules.
const OUT_DIR = fileURLToPath(
	new URL(`../../node_modules/.tmp/worker-${randomBytes(4).toString('hex')}/`, import.meta.url)
);
const VITE = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));

let database: TestDatabase;
let worker: ChildProcess | undefined;

beforeAll(async () => {
	database = await createTestDatabase();
	await promisify(execFile)(
		process.execPath,
		[VITE, 'build', '--config', 'src/worker/bundle.config.ts', '--outDir', OUT_DIR, '--logLevel', 'warn'],
		{ cwd: ROOT }
	);
});

afterAll(async () => {
	if (worker && worker.exitCode === null && worker.signalCode === null) {
		const exited = new Promise((resolve) => worker?.once('exit', resolve));
		worker.kill('SIGKILL');
		await exited;
	}
	await rm(OUT_DIR, { recursive: true, force: true });
	await database.drop();
});

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe('worker process on a broken database connection', () => {
	it('gives the job of the broken transaction back instead of dying with its lease', async () => {
		const { db } = database;
		const { jobId } = await db.transaction((tx) =>
			enqueueJob(
				tx,
				'invitation.remind_due',
				{ terms_id: randomUUID() },
				{ inputVersion: '1', createdBy: { kind: 'system' } }
			)
		);

		// The job's result is written in a transaction that reads the invitation terms: with the table locked, that
		// transaction waits on the server with the job row locked and the lease taken, until its backend is killed.
		const lock = await database.sql.reserve();
		await lock`begin`;
		await lock.unsafe(`lock table ${getTableName(invitationTerms)} in access exclusive mode`);

		const output: string[] = [];
		worker = spawn(
			process.execPath,
			[`${OUT_DIR}main.js`, '--types=invitation.remind_due', '--no-health', '--shutdown-grace-ms=2000'],
			{
				env: {
					PATH: process.env.PATH ?? '',
					...testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') })
				},
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		worker.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
		worker.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
		const exit = new Promise<number | null>((resolve) => {
			worker?.once('exit', resolve);
		});

		const pid = await waitFor(
			'the result write to wait on the lock',
			async () => {
				const [row] = await db.execute<{ pid: number }>(
					sql`select pid from pg_stat_activity
						where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`
				);
				return row?.pid;
			},
			15_000
		);
		const [claimed] = await db.select().from(jobs).where(eq(jobs.id, jobId));
		expect(claimed?.status).toBe('running');
		expect(claimed?.leaseOwner).not.toBeNull();

		await db.execute(sql`select pg_terminate_backend(${pid})`);
		await lock`commit`;
		lock.release();

		const settled = await waitFor(
			'the job to leave its lease',
			async () => {
				const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
				return row && row.status !== 'running' ? row : undefined;
			},
			15_000
		).catch((error: unknown) => {
			throw new Error(`${String(error)}; worker output:\n${output.join('')}`);
		});
		// The broken attempt is recorded and the job waits for its retry; nobody holds it.
		expect(settled.status).toBe('queued');
		expect(settled.leaseOwner).toBeNull();
		expect(settled.lastError).toMatchObject({ code: 'unexpected_error', retryable: true });

		// Either the break was handled where it happened and the worker goes on, or it surfaced as an uncaught error
		// and the worker stops on its own within its grace period.
		const exited = await Promise.race([
			exit,
			new Promise<'running'>((resolve) => setTimeout(resolve, 10_000, 'running'))
		]);
		const lines = output
			.join('')
			.split('\n')
			.filter((line) => line.startsWith('{'))
			.map((line) => JSON.parse(line) as { msg: string });
		if (exited === 'running') {
			expect(lines).not.toContainEqual(expect.objectContaining({ msg: 'uncaught error, stopping the worker' }));
			worker.kill('SIGTERM');
			expect(await exit).toBe(0);
		} else {
			// Stopped on an uncaught error: it said why and exited with 1, so that Docker starts it again.
			expect(exited).toBe(1);
			expect(lines).toContainEqual(expect.objectContaining({ msg: 'uncaught error, stopping the worker' }));
			expect(lines).toContainEqual(expect.objectContaining({ msg: 'worker stopped' }));
		}
	});
});
