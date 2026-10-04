// Vite config of the worker build (not named vite.config.ts: SvelteKit tooling treats such a file as an app root).
// Build of the worker process: an SSR bundle of src/worker/main.ts in build/worker/, run by plain Node. Dependencies
// stay external and come from node_modules of the image; `$lib` and the build constants are the application's.
// Runs after the application build, which empties build/.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import appConfig from '../../vite.config.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
	root,
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('../lib', import.meta.url)),
			'$env/dynamic/private': fileURLToPath(new URL('./env.ts', import.meta.url))
		}
	},
	define: appConfig.define,
	publicDir: false,
	build: {
		ssr: 'src/worker/main.ts',
		outDir: 'build/worker',
		emptyOutDir: true,
		target: 'node24',
		sourcemap: true
	}
});
