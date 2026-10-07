import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { testEnvironment } from '../../../tests/helpers/environment';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { ConfigError, parseConfig } = await import('./config');

/** FSP ID and the achievements source pointed at the simulator, as in .env.example. */
const FSP_SIMULATOR = {
	FSP_ID_ISSUER: 'http://fsp-mock.localhost:57610/realms/fsp',
	FSP_ID_CLIENT_ID: 'fsp-career',
	FSP_ID_CLIENT_SECRET: 'c'.repeat(32),
	FSP_ID_REDIRECT_URI: 'http://localhost:57173/auth/fsp/callback',
	FSP_ID_SCOPES: 'openid profile email',
	FSP_ACHIEVEMENTS_ADAPTER: 'mock',
	FSP_ACHIEVEMENTS_BASE_URL: 'http://fsp-mock.localhost:57610',
	FSP_WEBHOOK_SECRET: 'w'.repeat(32),
	FSP_ASSERTION_SECRET: 'a'.repeat(32)
};

function captureError(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('Expected the call to throw');
}

describe('parseConfig', () => {
	it('accepts a complete environment with optional integrations disabled', () => {
		const config = parseConfig(testEnvironment());
		expect(config.databaseUrl).toBe('postgres://app:app@localhost:5432/app');
		expect(config.appOrigin).toBe('http://localhost:57173');
		expect(config.crypto.activeFieldKeyVersion).toBe(1);
		expect(config.crypto.fieldKeys.get(1)).toHaveLength(32);
		expect(config.crypto.receiptSigningKeys.get('test-1')).toHaveLength(32);
		expect(config.docparse.url).toBe('http://localhost:8080');
		expect(config.sandbox).toEqual({ url: 'http://localhost:8081', maxConcurrentRuns: 2 });
		expect(config.fspId).toBeNull();
		expect(config.fspAchievements).toBeNull();
		expect(config.models).toEqual({ extract: null, embed: null, rerank: null });
		expect(config.telegram).toBeNull();
	});

	it('accepts .env.example as is: every variable the application needs has a working local value', () => {
		const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
		const config = parseConfig(example);
		expect(config.fspId?.issuer).toBe('http://fsp-mock.localhost:57610/realms/fsp');
		expect(config.fspAchievements?.adapter).toBe('mock');
		expect(config.sandbox).toEqual({ url: 'http://localhost:57950', maxConcurrentRuns: 2 });
		// The external model of the demonstration stand by default; without a key — the path without a model.
		expect(config.models.extract).toMatchObject({
			baseUrl: 'https://llmgate.volkv.com/v1',
			runtime: 'api',
			model: 'gemini-flash:latest',
			apiKey: null
		});
	});

	it('requires the sandbox address and a positive whole number of concurrent runs', () => {
		expect(() => parseConfig(testEnvironment({ SANDBOX_URL: '' }))).toThrow(/SANDBOX_URL/);
		expect(parseConfig(testEnvironment({ SANDBOX_MAX_CONCURRENT_RUNS: '4' })).sandbox.maxConcurrentRuns).toBe(4);
		for (const invalid of ['0', '-1', '1.5', 'two']) {
			expect(() => parseConfig(testEnvironment({ SANDBOX_MAX_CONCURRENT_RUNS: invalid }))).toThrow(
				/SANDBOX_MAX_CONCURRENT_RUNS/
			);
		}
	});

	it('treats empty values as not set', () => {
		const config = parseConfig(testEnvironment({ LLM_BASE_URL: '', TELEGRAM_BOT_TOKEN: '' }));
		expect(config.models.extract).toBeNull();
		expect(config.telegram).toBeNull();
	});

	it('rejects missing variables and names each of them', () => {
		expect(() => parseConfig({})).toThrow(ConfigError);
		expect(() => parseConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*FIELD_ENCRYPTION_KEYS/);
	});

	it('rejects a URL with the wrong scheme', () => {
		expect(() => parseConfig(testEnvironment({ DATABASE_URL: 'mysql://localhost/app' }))).toThrow(/DATABASE_URL/);
	});

	it('rejects keys of the wrong length and an active key outside the ring', () => {
		const short = Buffer.alloc(16).toString('base64');
		expect(() => parseConfig(testEnvironment({ FIELD_ENCRYPTION_KEYS: `1:${short}` }))).toThrow(
			/FIELD_ENCRYPTION_KEYS/
		);
		expect(() => parseConfig(testEnvironment({ FIELD_ENCRYPTION_ACTIVE_KEY: '2' }))).toThrow(
			/FIELD_ENCRYPTION_ACTIVE_KEY: must name a key/
		);
		expect(() => parseConfig(testEnvironment({ FIELD_HMAC_SECRET: short }))).toThrow(/FIELD_HMAC_SECRET/);
	});

	it('refuses a partially configured integration instead of disabling it', () => {
		expect(() => parseConfig(testEnvironment({ LLM_BASE_URL: 'http://llm:8000/v1' }))).toThrow(
			/LLM_MODEL: required when LLM_BASE_URL/
		);
		expect(() => parseConfig(testEnvironment({ FSP_ID_CLIENT_ID: 'client' }))).toThrow(
			/FSP_ID_ISSUER: required when FSP_ID_CLIENT_ID/
		);
	});

	it('configures FSP ID and the achievements source of the local simulator', () => {
		const config = parseConfig(testEnvironment(FSP_SIMULATOR));
		expect(config.fspId).toEqual({
			issuer: 'http://fsp-mock.localhost:57610/realms/fsp',
			clientId: 'fsp-career',
			clientSecret: 'c'.repeat(32),
			redirectUri: 'http://localhost:57173/auth/fsp/callback',
			scopes: 'openid profile email'
		});
		expect(config.fspAchievements).toEqual({
			adapter: 'mock',
			baseUrl: 'http://fsp-mock.localhost:57610',
			webhookSecret: 'w'.repeat(32),
			assertionSecret: 'a'.repeat(32)
		});
	});

	it('requires FSP ID with the achievements source: its service token comes from a FSP ID client_credentials grant', () => {
		expect(() =>
			parseConfig(
				testEnvironment({
					...FSP_SIMULATOR,
					FSP_ID_ISSUER: '',
					FSP_ID_CLIENT_ID: '',
					FSP_ID_CLIENT_SECRET: '',
					FSP_ID_REDIRECT_URI: '',
					FSP_ID_SCOPES: ''
				})
			)
		).toThrow(/FSP_ID_ISSUER: required when FSP_ACHIEVEMENTS_ADAPTER is set/);
	});

	it('requires the consent assertion secret with the achievements source and refuses a short one', () => {
		expect(() => parseConfig(testEnvironment({ ...FSP_SIMULATOR, FSP_ASSERTION_SECRET: '' }))).toThrow(
			/FSP_ASSERTION_SECRET: required when FSP_ACHIEVEMENTS_ADAPTER/
		);
		expect(() => parseConfig(testEnvironment({ ...FSP_SIMULATOR, FSP_ASSERTION_SECRET: 'a'.repeat(31) }))).toThrow(
			/FSP_ASSERTION_SECRET/
		);
		expect(() => parseConfig(testEnvironment({ FSP_ASSERTION_SECRET: 'a'.repeat(32) }))).toThrow(
			/FSP_ACHIEVEMENTS_ADAPTER: required when FSP_ASSERTION_SECRET/
		);
	});

	it('applies the contract defaults of a configured model operation', () => {
		const config = parseConfig(testEnvironment({ LLM_BASE_URL: 'https://llm.example/v1', LLM_MODEL: 'flash' }));
		expect(config.models.extract).toEqual({
			baseUrl: 'https://llm.example/v1',
			runtime: 'api',
			model: 'flash',
			apiKey: null,
			timeoutMs: 120_000,
			interactiveTimeoutMs: 30_000,
			maxConcurrency: 8,
			breaker: { failures: 3, cooldownMs: 30_000 }
		});
		expect(
			parseConfig(testEnvironment({ LLM_BASE_URL: 'http://llm:8000/v1', LLM_MODEL: 'qwen', LLM_RUNTIME: 'vllm' }))
				.models.extract?.runtime
		).toBe('vllm');
		expect(() =>
			parseConfig(testEnvironment({ LLM_BASE_URL: 'http://llm:8000/v1', LLM_MODEL: 'qwen', LLM_RUNTIME: 'ollama' }))
		).toThrow(/LLM_RUNTIME/);
		const rerank = { RERANK_BASE_URL: 'http://rerank:8001/v1', RERANK_MODEL: 'bge' };
		expect(parseConfig(testEnvironment(rerank)).models.rerank).toMatchObject({ topN: 50, truncateTokens: 1_024 });
		expect(
			parseConfig(testEnvironment({ ...rerank, RERANK_TRUNCATE_TOKENS: '512' })).models.rerank?.truncateTokens
		).toBe(512);
	});

	it('caps the default interactive deadline by the operation timeout and refuses a longer explicit one', () => {
		const embed = { EMBED_BASE_URL: 'http://embed:8080/v1', EMBED_MODEL: 'e5', EMBED_SPACE_ID: 'e5@r1/1024' };
		expect(parseConfig(testEnvironment({ ...embed, EMBED_TIMEOUT_MS: '3000' })).models.embed).toMatchObject({
			timeoutMs: 3_000,
			interactiveTimeoutMs: 3_000
		});
		expect(parseConfig(testEnvironment({ ...embed, EMBED_INTERACTIVE_TIMEOUT_MS: '800' })).models.embed).toMatchObject({
			timeoutMs: 30_000,
			interactiveTimeoutMs: 800
		});
		expect(() =>
			parseConfig(testEnvironment({ ...embed, EMBED_TIMEOUT_MS: '1000', EMBED_INTERACTIVE_TIMEOUT_MS: '2000' }))
		).toThrow(/EMBED_INTERACTIVE_TIMEOUT_MS: must not exceed EMBED_TIMEOUT_MS/);
		expect(() => parseConfig(testEnvironment({ LLM_INTERACTIVE_TIMEOUT_MS: '200000' }))).toThrow(
			/LLM_INTERACTIVE_TIMEOUT_MS: must not exceed LLM_TIMEOUT_MS/
		);
	});

	it('never echoes variable values in the error', () => {
		const leaking = testEnvironment({ REDIS_URL: 'http://user:secret-password@localhost' });
		const error = captureError(() => parseConfig(leaking));
		expect(error).toBeInstanceOf(ConfigError);
		expect(String(error)).not.toContain('secret-password');
	});

	it('configures the bootstrap administrator by its address; the password is optional, never without the address', () => {
		const password = 'stand administrator 2026';
		expect(parseConfig(testEnvironment()).bootstrapAdmin).toBeNull();
		expect(
			parseConfig(testEnvironment({ BOOTSTRAP_ADMIN_EMAIL: 'admin@example.org', BOOTSTRAP_ADMIN_PASSWORD: password }))
				.bootstrapAdmin
		).toEqual({ email: 'admin@example.org', password });
		// After the first start the password leaves the environment: the address alone confirms the role.
		expect(parseConfig(testEnvironment({ BOOTSTRAP_ADMIN_EMAIL: 'admin@example.org' })).bootstrapAdmin).toEqual({
			email: 'admin@example.org',
			password: null
		});
		expect(
			parseConfig(testEnvironment({ BOOTSTRAP_ADMIN_EMAIL: 'admin@example.org', BOOTSTRAP_ADMIN_PASSWORD: '' }))
				.bootstrapAdmin
		).toEqual({ email: 'admin@example.org', password: null });
		expect(() => parseConfig(testEnvironment({ BOOTSTRAP_ADMIN_PASSWORD: password }))).toThrow(
			/BOOTSTRAP_ADMIN_EMAIL: required when BOOTSTRAP_ADMIN_PASSWORD is set/
		);
		const error = captureError(() =>
			parseConfig(testEnvironment({ BOOTSTRAP_ADMIN_EMAIL: 'not an address', BOOTSTRAP_ADMIN_PASSWORD: password }))
		);
		expect(String(error)).toContain('BOOTSTRAP_ADMIN_EMAIL');
		expect(String(error)).not.toContain(password);
	});

	it('resets a demonstration stand every night unless DEMO_NIGHTLY_RESET says false', () => {
		const stand = {
			...FSP_SIMULATOR,
			DEMO_MODE: 'true',
			FSP_MOCK_SEED: 'seed',
			FSP_MOCK_ATHLETES: '200',
			FSP_MOCK_CONTROL_TOKEN: 'k'.repeat(32)
		};
		expect(parseConfig(testEnvironment(stand)).demo?.nightlyReset).toBe(true);
		expect(parseConfig(testEnvironment({ ...stand, DEMO_NIGHTLY_RESET: '' })).demo?.nightlyReset).toBe(true);
		expect(parseConfig(testEnvironment({ ...stand, DEMO_NIGHTLY_RESET: 'true' })).demo?.nightlyReset).toBe(true);
		expect(parseConfig(testEnvironment({ ...stand, DEMO_NIGHTLY_RESET: 'false' })).demo?.nightlyReset).toBe(false);
		expect(() => parseConfig(testEnvironment({ ...stand, DEMO_NIGHTLY_RESET: 'no' }))).toThrow(/DEMO_NIGHTLY_RESET/);
	});
});
