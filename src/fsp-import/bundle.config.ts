// Vite config of the FSP results import command (not named vite.config.ts: SvelteKit tooling treats such a file as an
// app root). An SSR bundle of src/fsp-import/main.ts in build/fsp-import/, run by plain Node through
// scripts/fsp-import.ts. Dependencies stay external and come from node_modules; `$lib` is the application's.
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
		ssr: 'src/fsp-import/main.ts',
		outDir: 'build/fsp-import',
		emptyOutDir: true,
		target: 'node24',
		sourcemap: true
	}
});
