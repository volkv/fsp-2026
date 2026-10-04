// `$env/dynamic/private`, which a spec needs through `$lib/server/config` to seed via the application's own server
// modules ($lib/server/*), only SvelteKit provides. This hook resolves it to `process.env` instead, for a plain Node
// test process. `playwright.config.ts` loads this file two ways, both needed:
//
//  - a direct `import`, so the hook is active in the process Playwright itself runs in (it collects tests by
//    importing every spec file directly, before any worker starts);
//  - `--import` through `NODE_OPTIONS`, in the environment every worker process inherits (`fork()`, playwright's
//    `ProcessHost`): a worker is a separate Node process that does not inherit the direct import's effect, and each
//    reads `NODE_OPTIONS` from its own environment at its own startup, before it loads any spec file.
//
// Either alone is not enough. In particular, a spec cannot register this itself, from its own top-level code, ahead of
// its own static imports: static imports resolve before any of the importing file's top-level code runs, so a spec
// whose static graph reaches `$lib/server/config` (such as `$lib/server/fsp/receipts`) needs the hook active before
// the spec file is loaded at all, not from within it.
//
// `registerHooks` (not the asynchronous `module.register`) is what makes this synchronous: it installs the hook
// in-thread, so it is guaranteed active as soon as this module finishes evaluating.
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '$env/dynamic/private') {
			return { url: 'data:text/javascript,export const env = process.env;', shortCircuit: true };
		}
		return nextResolve(specifier, context);
	}
});

process.loadEnvFile('.env');
