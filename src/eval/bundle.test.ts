// The bridge as the harness runs it: the built bundle under plain Node, away from the sources it was built from.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESUME_SCHEMA_VERSION } from '$lib/server/resumes/extract-job';
import { bridgeRevision, checkoutState, evalBundleConfig } from './bundle.config';
import { loadEvalTaxonomy } from './taxonomy';

const root = fileURLToPath(new URL('../..', import.meta.url));
let outDir: string;

beforeAll(async () => {
	// Deeper than .eval-build/ and still inside the checkout, so the bundle's external imports resolve from node_modules.
	const parent = join(root, 'node_modules', '.cache');
	await mkdir(parent, { recursive: true });
	outDir = await mkdtemp(join(parent, 'eval-bundle-'));
	// Only this config: the application's vite.config.ts in the same root is not the bridge's.
	await build({ ...evalBundleConfig(outDir), configFile: false, logLevel: 'silent' });
}, 120_000);

afterAll(async () => {
	if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe('evaluation bridge bundle', () => {
	it('finds the taxonomy of the checkout from where it is built', async () => {
		const run = spawnSync(process.execPath, [join(outDir, 'main.js')], {
			input: JSON.stringify({ command: 'info' }),
			encoding: 'utf8',
			env: { PATH: process.env.PATH ?? '' }
		});
		expect(run.stderr).toBe('');
		expect(run.status).toBe(0);
		const taxonomy = await loadEvalTaxonomy(join(root, 'taxonomy'));
		expect(JSON.parse(run.stdout)).toMatchObject({
			product_revision: bridgeRevision(checkoutState(root), process.env.APP_COMMIT),
			versions: {
				taxonomy: taxonomy.label,
				taxonomy_sha256: taxonomy.contentSha256,
				resume_schema: RESUME_SCHEMA_VERSION
			}
		});
	});

	it('reports a checkout with uncommitted changes as its commit marked -dirty', () => {
		expect(bridgeRevision({ head: '0123456789ab', dirty: false }, undefined)).toBe('0123456789ab');
		expect(bridgeRevision({ head: '0123456789ab', dirty: true }, undefined)).toBe('0123456789ab-dirty');
		// A commit from the environment stands only for a clean checkout, or when it is marked itself.
		expect(bridgeRevision({ head: '0123456789ab', dirty: false }, 'fedcba987654')).toBe('fedcba987654');
		expect(bridgeRevision({ head: '0123456789ab', dirty: true }, 'fedcba987654-dirty')).toBe('fedcba987654-dirty');
		expect(() => bridgeRevision({ head: '0123456789ab', dirty: true }, 'fedcba987654')).toThrow('uncommitted changes');
	});

	it('sees any change of a checkout but the ignored files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'eval-checkout-'));
		try {
			const git = (...args: string[]) =>
				execFileSync('git', [
					'-C',
					dir,
					'-c',
					'user.name=t',
					'-c',
					'user.email=t@example.com',
					'-c',
					'commit.gpgsign=false',
					...args
				]);
			git('init', '-q');
			await writeFile(join(dir, '.gitignore'), 'out/\n');
			await writeFile(join(dir, 'code.ts'), 'export {};\n');
			git('add', '.');
			git('commit', '-qm', 'init');
			const head = execFileSync('git', ['-C', dir, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
			expect(checkoutState(dir)).toEqual({ head, dirty: false });
			await mkdir(join(dir, 'out'));
			await writeFile(join(dir, 'out', 'report.json'), '{}');
			expect(checkoutState(dir).dirty).toBe(false);
			await writeFile(join(dir, 'new.ts'), 'export {};\n');
			expect(checkoutState(dir).dirty).toBe(true);
			await rm(join(dir, 'new.ts'));
			await writeFile(join(dir, 'code.ts'), 'export const changed = 1;\n');
			expect(checkoutState(dir).dirty).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
