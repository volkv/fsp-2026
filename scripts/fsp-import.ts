// Imports an FSP results batch — an export (CSV, XLSX) or a protocol (PDF, DOCX, ODT, RTF) — through a mapping profile
// into the database from DATABASE_URL (docs/contracts.md 1.7). The import runs on the application's code, so this
// script builds the command (src/fsp-import/bundle.config.ts) and runs it with the environment of .env:
//
//   node scripts/fsp-import.ts --profile <profile.json> [--complete] [--dry-run] [--allow-row-issues] <file>
//
// Arguments are passed through (paths relative to the current directory); the exit code is the command's.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command: string, args: string[], cwd: string): number {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.signal) throw new Error(`${command} stopped by ${result.signal}`);
	return result.status ?? 1;
}

const built = run(
	process.execPath,
	[
		`${root}node_modules/vite/bin/vite.js`,
		'build',
		'--config',
		'src/fsp-import/bundle.config.ts',
		'--logLevel',
		'warn'
	],
	root
);
if (built !== 0) {
	process.exitCode = built;
} else {
	const envFile = `${root}.env`;
	process.exitCode = run(
		process.execPath,
		[
			...(existsSync(envFile) ? [`--env-file=${envFile}`] : []),
			'--enable-source-maps',
			`${root}build/fsp-import/main.js`,
			...process.argv.slice(2)
		],
		process.cwd()
	);
}
