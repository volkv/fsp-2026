// Command line of the worker process. The enabled job types are always explicit: a worker never runs «everything
// registered», so deploying a new handler is a deliberate change of this list (compose.yaml).
import { parseArgs } from 'node:util';

export interface WorkerArgs {
	types: string[];
	concurrency: Record<string, number>;
	/** Port of the state endpoint; `null` — no endpoint. */
	healthPort: number | null;
	shutdownGraceMs: number | undefined;
}

export const USAGE =
	'usage: worker --types <type>[,<type>…] [--concurrency <type>=<n>]… [--health-port <port>|--no-health] ' +
	'[--shutdown-grace-ms <ms>]';

// Loopback only (src/worker/health.ts); the 57xxx range of the project, see docs/development.md.
const DEFAULT_HEALTH_PORT = 57310;

function positiveInteger(value: string, what: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${what} must be a positive integer, got ${value}`);
	return Number(value);
}

export function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
	const { values } = parseArgs({
		args: [...argv],
		strict: true,
		allowPositionals: false,
		options: {
			types: { type: 'string' },
			concurrency: { type: 'string', multiple: true },
			'health-port': { type: 'string' },
			'no-health': { type: 'boolean' },
			'shutdown-grace-ms': { type: 'string' }
		}
	});
	if (!values.types) throw new Error(`--types is required\n${USAGE}`);
	const types = values.types
		.split(',')
		.map((type) => type.trim())
		.filter((type) => type !== '');
	const concurrency: Record<string, number> = {};
	for (const entry of values.concurrency ?? []) {
		const separator = entry.indexOf('=');
		if (separator < 1) throw new Error(`--concurrency expects <type>=<n>, got ${entry}`);
		const type = entry.slice(0, separator);
		if (Object.hasOwn(concurrency, type)) throw new Error(`--concurrency for ${type} is given twice`);
		concurrency[type] = positiveInteger(entry.slice(separator + 1), `concurrency of ${type}`);
	}
	if (values['no-health'] && values['health-port'] !== undefined) {
		throw new Error('--health-port and --no-health exclude each other');
	}
	return {
		types,
		concurrency,
		healthPort: values['no-health']
			? null
			: values['health-port'] === undefined
				? DEFAULT_HEALTH_PORT
				: positiveInteger(values['health-port'], '--health-port'),
		shutdownGraceMs:
			values['shutdown-grace-ms'] === undefined
				? undefined
				: positiveInteger(values['shutdown-grace-ms'], '--shutdown-grace-ms')
	};
}
