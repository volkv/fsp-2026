import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			expect: { requireAssertions: true },
			projects: [
				{
					extends: true,
					test: {
						name: 'unit',
						environment: 'node',
						include: ['src/**/*.test.ts']
					}
				},
				{
					extends: true,
					test: {
						name: 'integration',
						environment: 'node',
						include: ['tests/integration/**/*.test.ts'],
						globalSetup: ['tests/integration/global-setup.ts'],
						testTimeout: 30_000,
						hookTimeout: 180_000
					}
				}
			]
		}
	})
);
