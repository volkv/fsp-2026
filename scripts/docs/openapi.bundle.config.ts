// Vite config of the OpenAPI export for the documentation build (not named vite.config.ts: SvelteKit tooling treats such
// a file as an app root): an SSR bundle of openapi-main.ts in build/docs-openapi/, run by plain Node. It builds the
// document with the code the application serves `/api/v1/openapi.json` with, so no running application is needed.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import appConfig from '../../vite.config.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
	root,
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('../../src/lib', import.meta.url)),
			'$env/dynamic/private': fileURLToPath(new URL('../../src/worker/env.ts', import.meta.url))
		}
	},
	define: appConfig.define,
	publicDir: false,
	logLevel: 'warn',
	build: {
		ssr: 'scripts/docs/openapi-main.ts',
		outDir: 'build/docs-openapi',
		emptyOutDir: true,
		target: 'node24'
	}
});
