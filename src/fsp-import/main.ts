// Import of an FSP results batch from the command line (docs/contracts.md 1.7), started by scripts/fsp-import.ts:
//
//   fsp-import --profile <profile.json> [--complete] [--dry-run] [--allow-row-issues] <file>
//
// The file is an export (CSV, XLSX) or a protocol (PDF, DOCX, ODT, RTF), told apart by content. `--dry-run` reads and
// checks the batch without the database. The report on stdout is JSON: counts, competitions and row issues by row,
// column and reason — no person's data from the file. Exit code 0 — imported (or checked), 1 — refused, 2 — wrong usage.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb, db } from '$lib/server/db';
import { docparse } from '$lib/server/documents/docparse';
import { importResultsBatch } from '$lib/server/fsp/import/apply';
import { feedFor, type ResultsBatch } from '$lib/server/fsp/import/feed';
import { parseProfile } from '$lib/server/fsp/import/profile';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { closeRedis } from '$lib/server/redis';
import { loggedError } from '$lib/server/db/errors';

const USAGE = 'usage: fsp-import --profile <profile.json> [--complete] [--dry-run] [--allow-row-issues] <file>';

class UsageError extends Error {
	override name = 'UsageError';
}

function report(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, '\t')}\n`);
}

/** What the report says about a batch: its shape and its issues, not its rows. */
function describeBatch(batch: ResultsBatch) {
	return {
		variant: batch.variant,
		format: batch.format,
		profile: batch.profile,
		sha256: batch.sha256,
		rowsRead: batch.rowsRead,
		rowsValid: batch.rows.length,
		rowsWithFspId: batch.rows.filter((r) => r.participant.fspId !== undefined).length,
		completeness: batch.completeness,
		ocrUsed: batch.ocrUsed,
		competitions: batch.competitions.map((c) => ({
			id: c.id,
			title: c.title,
			ekpNumber: c.ekpNumber,
			discipline: c.discipline,
			level: c.level,
			startDate: c.startDate
		})),
		issues: batch.issues
	};
}

const OPTIONS = {
	profile: { type: 'string' },
	complete: { type: 'boolean' },
	'dry-run': { type: 'boolean' },
	'allow-row-issues': { type: 'boolean' }
} as const;

function readArgs() {
	try {
		return parseArgs({ options: OPTIONS, allowPositionals: true });
	} catch (error) {
		// parseArgs reports an unknown or malformed option as a TypeError.
		if (error instanceof TypeError) throw new UsageError(error.message);
		throw error;
	}
}

async function main(): Promise<number> {
	const args = readArgs();
	const [file, ...rest] = args.positionals;
	if (!args.values.profile || file === undefined || rest.length > 0) throw new UsageError('a profile and one file');

	const profile = parseProfile(JSON.parse(await readFile(args.values.profile, 'utf8')));
	if (!profile.ok) {
		report({ ok: false, code: 'profile_invalid', issues: profile.issues });
		return 1;
	}
	const bytes = new Uint8Array(await readFile(file));
	const requestId = `fsp-import-${randomUUID()}`;
	const read = await feedFor(bytes, docparse).readBatch({
		bytes,
		declaredName: basename(file),
		profile: profile.profile,
		declaredComplete: args.values.complete === true,
		requestId
	});
	if (!read.ok) {
		report({ ok: false, code: read.error.code, retryable: read.error.retryable, message: read.error.message });
		return 1;
	}
	const batch = read.value;
	if (args.values['dry-run']) {
		report({ ok: batch.issues.length === 0, dryRun: true, batch: describeBatch(batch) });
		return batch.issues.length === 0 ? 0 : 1;
	}
	const imported = await importResultsBatch(db(), batch, {
		actor: { kind: 'system' },
		createdBy: { kind: 'system' },
		requestId,
		signer: configuredReceiptSigner(),
		allowRowIssues: args.values['allow-row-issues'] === true
	});
	report(
		imported.ok
			? { ok: true, batch: describeBatch(batch), import: imported.summary }
			: { ok: false, code: imported.code, message: imported.message, batch: describeBatch(batch) }
	);
	return imported.ok ? 0 : 1;
}

main()
	.then(async (code) => {
		process.exitCode = code;
		closeRedis();
		await closeDb();
	})
	.catch(async (error: unknown) => {
		if (error instanceof UsageError) {
			console.error(`${error.message}\n${USAGE}`);
			process.exitCode = 2;
		} else {
			console.error('[fsp-import]', loggedError(error));
			process.exitCode = 1;
		}
		closeRedis();
		await closeDb();
	});
