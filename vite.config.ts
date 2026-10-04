import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-node';
import type { KitConfig } from '@sveltejs/kit';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { coreCspDirectives } from './src/lib/server/http/security-headers.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
	version: string;
};

/** Commit of the build: `APP_COMMIT` (Docker build arg) or the current git HEAD. */
function resolveCommit(): string {
	const fromEnv = process.env.APP_COMMIT;
	if (fromEnv) return fromEnv;
	try {
		return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch (cause) {
		throw new Error('Cannot determine build commit: set APP_COMMIT or build inside a git checkout', {
			cause
		});
	}
}

/**
 * Policy of rendered pages; SvelteKit adds a nonce (hash on prerendered pages) for the inline scripts it generates.
 * Everything is served by the application itself: no external sources, fonts are local. A page response carries this
 * header instead of the one of every response (src/lib/server/http/security-headers.ts), so the directives
 * independent of page content come from there. Exported for the test that the two agree.
 */
export const pageCsp = {
	mode: 'auto',
	directives: {
		'default-src': ['self'],
		'script-src': ['self'],
		// Inline style attributes come from server rendering and from UI components at run time; 'unsafe-inline'
		// here also makes SvelteKit skip style nonces, which would disable it.
		'style-src': ['self', 'unsafe-inline'],
		'img-src': ['self'],
		'font-src': ['self'],
		'connect-src': ['self'],
		...coreCspDirectives()
	}
} satisfies KitConfig['csp'];

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: adapter(),
			csp: pageCsp,
			compilerOptions: {
				// Runes mode is mandatory for project code; libraries keep their own mode.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			typescript: {
				config(config) {
					const include = config.include as string[];
					include.push('../scripts/**/*.ts', '../vitest.config.ts', '../playwright.config.ts');
				}
			}
		})
	],
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__APP_COMMIT__: JSON.stringify(resolveCommit())
	},
	server: {
		port: 57173,
		strictPort: true
	},
	preview: {
		port: 57174,
		strictPort: true
	}
});
