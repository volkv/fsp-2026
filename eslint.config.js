import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig(
	globalIgnores(['build/', '.eval-build/', '.svelte-kit/', 'node_modules/', 'test-results/', 'playwright-report/']),
	js.configs.recommended,
	ts.configs.strictTypeChecked,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				// Set here, not only on the `.svelte` block below: typescript-eslint's project service compares this
				// array on every file and reloads the whole project when it changes, so a value that differs between
				// `.ts` and `.svelte` files makes it reload on every alternation between them (thousands of times
				// across the tree) instead of once. The same array on all files keeps the comparison a no-op.
				extraFileExtensions: ['.svelte']
			}
		},
		rules: {
			// typescript-eslint recommends disabling this for TypeScript projects: the compiler reports undefined names.
			'no-undef': 'off',
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				svelteConfig: { compilerOptions: { runes: true } }
			}
		}
	},
	{
		files: ['**/*.js'],
		extends: [ts.configs.disableTypeChecked]
	}
);
