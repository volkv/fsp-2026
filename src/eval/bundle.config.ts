// Vite config of the evaluation bridge build (not named vite.config.ts: SvelteKit tooling treats such a file as an app
// root). An SSR bundle of src/eval/main.ts in .eval-build/, run by plain Node from the evaluation harness (tools/eval).
// Out of tree from build/: `pnpm build` empties that directory, and the bridge must survive it between eval runs.
// Dependencies stay external and come from node_modules; `$lib` and the build constants are the application's, so the
// harness measures the code of this commit — and the commit it reports says whether the checkout had anything else.
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vite';
import appConfig from '../../vite.config.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The commit a checkout stands on and whether its files differ from it. */
export interface CheckoutState {
	head: string;
	/** Changed, staged or untracked files beside the ignored ones (build output, `tools/eval/out`, `.env`). */
	dirty: boolean;
}

/** State of the git checkout at `dir`; the bridge is built from a checkout only, so no git is an error. */
export function checkoutState(dir: string): CheckoutState {
	const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
	try {
		return { head: git('rev-parse', '--short=12', 'HEAD').trim(), dirty: git('status', '--porcelain').trim() !== '' };
	} catch (cause) {
		throw new Error('The evaluation bridge is built from a git checkout: its revision is read from git', { cause });
	}
}

/**
 * Revision the bridge reports (`info.product_revision`): the commit, with `-dirty` when the checkout differs from it —
 * the numbers of such a build belong to no commit, and a run on the holdout refuses it (tools/eval, holdout.py).
 * `APP_COMMIT` of the environment is taken only when the checkout is clean or it carries the `-dirty` mark itself.
 */
export function bridgeRevision(state: CheckoutState, fromEnv: string | undefined): string {
	const own = state.dirty ? `${state.head}-dirty` : state.head;
	if (!fromEnv) return own;
	if (state.dirty && !fromEnv.endsWith('-dirty')) {
		throw new Error(
			`APP_COMMIT=${fromEnv} names a commit, and the checkout has uncommitted changes: unset it or mark it -dirty`
		);
	}
	return fromEnv;
}

/**
 * The bridge build into `outDir`. The bundle finds the checkout — `taxonomy/`, `assessments/` and the migrations — by
 * the path from its own directory, computed here from `outDir` (`__EVAL_CHECKOUT_DIR__`): the checkout is mounted
 * anywhere, and only the build knows where the bundle lies in it.
 */
export function evalBundleConfig(outDir: string): UserConfig {
	const checkoutFromBundle = relative(outDir, root).split(sep).join('/');
	return {
		root,
		resolve: {
			alias: {
				$lib: fileURLToPath(new URL('../lib', import.meta.url)),
				'$env/dynamic/private': fileURLToPath(new URL('./env.ts', import.meta.url))
			}
		},
		define: {
			...appConfig.define,
			__APP_COMMIT__: JSON.stringify(bridgeRevision(checkoutState(root), process.env.APP_COMMIT)),
			__EVAL_CHECKOUT_DIR__: JSON.stringify(`${checkoutFromBundle}/`)
		},
		publicDir: false,
		build: {
			ssr: 'src/eval/main.ts',
			outDir,
			emptyOutDir: true,
			target: 'node24',
			sourcemap: true
		}
	};
}

export default defineConfig(evalBundleConfig(join(root, '.eval-build')));
