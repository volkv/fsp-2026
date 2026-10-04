// Vite config of the embedding space command line (not named vite.config.ts: SvelteKit tooling treats such a file as an
// app root): an SSR bundle of main.ts next to this file in build/embeddings/, run by plain Node like the worker, whose
// environment module it shares. Dependencies stay external and come from node_modules; `$lib` and the build constants
// are the application's. Runs after the application build, which empties build/.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import appConfig from '../../../../vite.config.ts';

const root = fileURLToPath(new URL('../../../..', import.meta.url));

export default defineConfig({
	root,
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('../..', import.meta.url)),
			'$env/dynamic/private': fileURLToPath(new URL('../../../worker/env.ts', import.meta.url))
		}
	},
	define: appConfig.define,
	publicDir: false,
	build: {
		ssr: 'src/lib/server/embeddings/main.ts',
		outDir: 'build/embeddings',
		emptyOutDir: true,
		target: 'node24',
		sourcemap: true
	}
});
