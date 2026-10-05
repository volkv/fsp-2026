import { env } from '$env/dynamic/private';
import { z } from 'zod';

// Environment of the application (docs/contracts.md sections 1, 2.1, 3.1, 6, 8; docs/domain.md section 0).
// An empty value means «not set». Optional integrations are configured as a whole group or not at all.

const optional = <T extends z.ZodType>(schema: T) =>
	z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const required = <T extends z.ZodType>(schema: T) =>
	z.preprocess((value) => (value === '' ? undefined : value), schema);

const httpUrl = z.url({ protocol: /^https?$/ });
const positiveInt = z.coerce.number().int().positive();

/** Standard base64 of exactly or at least `bytes` bytes. */
function base64Bytes(bytes: number, exact: boolean) {
	return z
		.string()
		.regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64')
		.transform((value) => Buffer.from(value, 'base64'))
		.refine((buffer) => (exact ? buffer.length === bytes : buffer.length >= bytes), {
			message: exact ? `must decode to exactly ${bytes} bytes` : `must decode to at least ${bytes} bytes`
		});
}

/** `id:base64,id:base64` — a key ring whose ids match `idPattern`. */
function keyRing(idPattern: RegExp, idDescription: string) {
	return z.string().transform((value, ctx) => {
		const ring = new Map<string, Buffer>();
		for (const entry of value.split(',')) {
			const separator = entry.indexOf(':');
			const keyId = entry.slice(0, separator).trim();
			const material = base64Bytes(32, true).safeParse(entry.slice(separator + 1).trim());
			if (separator < 1 || !idPattern.test(keyId) || !material.success || ring.has(keyId)) {
				ctx.addIssue({
					code: 'custom',
					message: `every entry must be <${idDescription}>:<base64 of 32 bytes> with a unique id`
				});
				return z.NEVER;
			}
			ring.set(keyId, material.data);
		}
		return ring;
	});
}

/** Defaults of docs/contracts.md, section 3.1; an interactive deadline is capped by the operation timeout. */
/**
 * Requests to the `extract` runtime one process sends at once. One GPU with an 8B model serves 8 with p95 ≈ 53 s; at 32
 * the throughput barely grows and p95 exceeds the 120 s timeout (docs/models.md). The `resume.extract` job runs as many.
 */
export const LLM_DEFAULT_MAX_CONCURRENCY = 8;

/** Tokens of a query and document pair the reranker keeps: the context of bge-reranker-v2-m3. */
const RERANK_DEFAULT_TRUNCATE_TOKENS = 1_024;

/**
 * The circuit breaker of a model operation: after this many failed calls in a row — a person's or a job's alike — the
 * runtime is not called for the cooldown, so a runtime that hangs costs one deadline, not one per request (contracts 3.5).
 */
const BREAKER_DEFAULTS = { failures: 3, cooldownMs: 30_000 } as const;

const MODEL_DEFAULTS = {
	extract: { timeoutMs: 120_000, interactiveTimeoutMs: 30_000 },
	embed: { timeoutMs: 30_000, interactiveTimeoutMs: 5_000 },
	rerank: { timeoutMs: 30_000, interactiveTimeoutMs: 5_000 }
} as const;

function deadlines(
	operation: keyof typeof MODEL_DEFAULTS,
	timeout: number | undefined,
	interactive: number | undefined
): { timeoutMs: number; interactiveTimeoutMs: number } {
	const timeoutMs = timeout ?? MODEL_DEFAULTS[operation].timeoutMs;
	return {
		timeoutMs,
		interactiveTimeoutMs: interactive ?? Math.min(MODEL_DEFAULTS[operation].interactiveTimeoutMs, timeoutMs)
	};
}

function breaker(failures: number | undefined, cooldownMs: number | undefined): BreakerConfig {
	return {
		failures: failures ?? BREAKER_DEFAULTS.failures,
		cooldownMs: cooldownMs ?? BREAKER_DEFAULTS.cooldownMs
	};
}

const envSchema = z
	.object({
		DATABASE_URL: required(z.url({ protocol: /^postgres(ql)?$/ })),
		REDIS_URL: required(z.url({ protocol: /^rediss?$/ })),
		APP_ORIGIN: required(httpUrl),

		FIELD_ENCRYPTION_KEYS: required(keyRing(/^([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/, 'version 1-255')),
		FIELD_ENCRYPTION_ACTIVE_KEY: required(z.string()),
		FIELD_HMAC_SECRET: required(base64Bytes(32, false)),
		RECEIPT_SIGNING_KEYS: required(keyRing(/^[a-z0-9][a-z0-9-]{0,31}$/, 'key id')),
		RECEIPT_ACTIVE_SIGNING_KEY: required(z.string()),

		S3_ENDPOINT: required(httpUrl),
		S3_REGION: required(z.string().min(1)),
		S3_ACCESS_KEY_ID: required(z.string().min(1)),
		S3_SECRET_ACCESS_KEY: required(z.string().min(1)),
		S3_BUCKET: required(z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid bucket name')),

		SMTP_URL: required(z.url({ protocol: /^smtps?$/ })),
		MAIL_FROM: required(z.string().min(3)),

		DOCPARSE_URL: required(httpUrl),

		SANDBOX_URL: required(httpUrl),
		SANDBOX_MAX_CONCURRENT_RUNS: optional(positiveInt),

		FSP_ID_ISSUER: optional(httpUrl),
		FSP_ID_CLIENT_ID: optional(z.string().min(1)),
		FSP_ID_CLIENT_SECRET: optional(z.string().min(1)),
		FSP_ID_REDIRECT_URI: optional(httpUrl),
		FSP_ID_SCOPES: optional(z.string().regex(/^openid( [a-z_:.]+)*$/, 'must start with openid')),

		COMPANY_REGISTRY: optional(z.enum(['egrul'])),
		/** Base of the Huntflow API v2 (`https://api.huntflow.ru/v2`); unset — the Huntflow adapter is off (contracts 13.3). */
		HUNTFLOW_API_URL: optional(httpUrl),

		CODEFORCES_API_URL: optional(httpUrl),
		GITHUB_API_URL: optional(httpUrl),
		GITHUB_TOKEN: optional(z.string().regex(/^[A-Za-z0-9_]{20,255}$/, 'must be a GitHub token')),

		FSP_ACHIEVEMENTS_ADAPTER: optional(z.enum(['mock', 'fsp-api'])),
		FSP_ACHIEVEMENTS_BASE_URL: optional(httpUrl),
		FSP_WEBHOOK_SECRET: optional(z.string().min(32)),
		FSP_ASSERTION_SECRET: optional(z.string().min(32)),

		LLM_BASE_URL: optional(httpUrl),
		LLM_MODEL: optional(z.string().min(1)),
		LLM_API_KEY: optional(z.string().min(1)),
		LLM_TIMEOUT_MS: optional(positiveInt),
		LLM_INTERACTIVE_TIMEOUT_MS: optional(positiveInt),
		LLM_MAX_CONCURRENCY: optional(positiveInt),
		LLM_BREAKER_FAILURES: optional(positiveInt),
		LLM_BREAKER_COOLDOWN_MS: optional(positiveInt),

		EMBED_BASE_URL: optional(httpUrl),
		EMBED_MODEL: optional(z.string().min(1)),
		EMBED_API_KEY: optional(z.string().min(1)),
		EMBED_SPACE_ID: optional(z.string().min(1)),
		EMBED_TIMEOUT_MS: optional(positiveInt),
		EMBED_INTERACTIVE_TIMEOUT_MS: optional(positiveInt),
		EMBED_BATCH_SIZE: optional(positiveInt),
		EMBED_BREAKER_FAILURES: optional(positiveInt),
		EMBED_BREAKER_COOLDOWN_MS: optional(positiveInt),

		RERANK_BASE_URL: optional(httpUrl),
		RERANK_MODEL: optional(z.string().min(1)),
		RERANK_API_KEY: optional(z.string().min(1)),
		RERANK_TIMEOUT_MS: optional(positiveInt),
		RERANK_INTERACTIVE_TIMEOUT_MS: optional(positiveInt),
		RERANK_TOP_N: optional(positiveInt),
		RERANK_TRUNCATE_TOKENS: optional(positiveInt),
		RERANK_BREAKER_FAILURES: optional(positiveInt),
		RERANK_BREAKER_COOLDOWN_MS: optional(positiveInt),

		TELEGRAM_BOT_TOKEN: optional(z.string().regex(/^[0-9]+:[A-Za-z0-9_-]+$/, 'must be a Bot API token')),
		TELEGRAM_BOT_USERNAME: optional(z.string().regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a bot username')),
		TELEGRAM_WEBHOOK_SECRET: optional(z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 of A-Z a-z 0-9 _ -')),

		BOOTSTRAP_ADMIN_EMAIL: optional(z.email().max(254)),
		BOOTSTRAP_ADMIN_PASSWORD: optional(z.string().min(1)),

		DEMO_MODE: optional(z.enum(['true', 'false']).transform((value) => value === 'true')),
		DEMO_CANDIDATES: optional(z.coerce.number().int().min(1).max(10_000)),
		DEMO_VACANCIES: optional(z.coerce.number().int().min(1).max(5_000)),
		DEMO_NIGHTLY_RESET: optional(z.enum(['true', 'false']).transform((value) => value === 'true')),
		FSP_MOCK_SEED: optional(z.string().min(1).max(200)),
		FSP_MOCK_ATHLETES: optional(z.coerce.number().int().min(200).max(5_000)),
		FSP_MOCK_CONTROL_TOKEN: optional(z.string().min(32))
	})
	.superRefine((value, ctx) => {
		if (!value.FIELD_ENCRYPTION_KEYS.has(value.FIELD_ENCRYPTION_ACTIVE_KEY)) {
			ctx.addIssue({
				code: 'custom',
				path: ['FIELD_ENCRYPTION_ACTIVE_KEY'],
				message: 'must name a key of FIELD_ENCRYPTION_KEYS'
			});
		}
		if (!value.RECEIPT_SIGNING_KEYS.has(value.RECEIPT_ACTIVE_SIGNING_KEY)) {
			ctx.addIssue({
				code: 'custom',
				path: ['RECEIPT_ACTIVE_SIGNING_KEY'],
				message: 'must name a key of RECEIPT_SIGNING_KEYS'
			});
		}
		// A person waits for an interactive call; its deadline is never longer than the background one.
		const deadlines = [
			[
				'LLM_INTERACTIVE_TIMEOUT_MS',
				value.LLM_INTERACTIVE_TIMEOUT_MS,
				'LLM_TIMEOUT_MS',
				value.LLM_TIMEOUT_MS,
				'extract'
			],
			[
				'EMBED_INTERACTIVE_TIMEOUT_MS',
				value.EMBED_INTERACTIVE_TIMEOUT_MS,
				'EMBED_TIMEOUT_MS',
				value.EMBED_TIMEOUT_MS,
				'embed'
			],
			[
				'RERANK_INTERACTIVE_TIMEOUT_MS',
				value.RERANK_INTERACTIVE_TIMEOUT_MS,
				'RERANK_TIMEOUT_MS',
				value.RERANK_TIMEOUT_MS,
				'rerank'
			]
		] as const;
		for (const [name, interactive, timeoutName, timeout, operation] of deadlines) {
			if (interactive !== undefined && interactive > (timeout ?? MODEL_DEFAULTS[operation].timeoutMs)) {
				ctx.addIssue({ code: 'custom', path: [name], message: `must not exceed ${timeoutName}` });
			}
		}
		// Groups: a partially configured integration is an error, not a silently disabled one.
		const groups: { name: string; members: (keyof typeof value)[]; trigger: keyof typeof value }[] = [
			{
				name: 'FSP ID',
				trigger: 'FSP_ID_ISSUER',
				members: ['FSP_ID_CLIENT_ID', 'FSP_ID_CLIENT_SECRET', 'FSP_ID_REDIRECT_URI']
			},
			{
				name: 'FSP achievements',
				trigger: 'FSP_ACHIEVEMENTS_ADAPTER',
				members: ['FSP_ACHIEVEMENTS_BASE_URL', 'FSP_WEBHOOK_SECRET', 'FSP_ASSERTION_SECRET']
			},
			{ name: 'extract', trigger: 'LLM_BASE_URL', members: ['LLM_MODEL'] },
			{ name: 'embed', trigger: 'EMBED_BASE_URL', members: ['EMBED_MODEL', 'EMBED_SPACE_ID'] },
			{ name: 'rerank', trigger: 'RERANK_BASE_URL', members: ['RERANK_MODEL'] },
			{
				name: 'Telegram',
				trigger: 'TELEGRAM_BOT_TOKEN',
				members: ['TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET']
			}
		];
		for (const group of groups) {
			const enabled = value[group.trigger] !== undefined;
			for (const member of group.members) {
				if (enabled && value[member] === undefined) {
					ctx.addIssue({
						code: 'custom',
						path: [member],
						message: `required when ${group.trigger} is set (${group.name})`
					});
				}
				if (!enabled && value[member] !== undefined) {
					ctx.addIssue({
						code: 'custom',
						path: [group.trigger],
						message: `required when ${member} is set (${group.name})`
					});
				}
			}
		}
		// The password of the bootstrap administrator is needed to create the account or reset its password only, so the
		// address stands alone once the account exists; a password without an address would be silently ignored.
		if (value.BOOTSTRAP_ADMIN_PASSWORD !== undefined && value.BOOTSTRAP_ADMIN_EMAIL === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['BOOTSTRAP_ADMIN_EMAIL'],
				message: 'required when BOOTSTRAP_ADMIN_PASSWORD is set (bootstrap administrator)'
			});
		}
		// Demonstration mode seeds and resets the whole database: its data world is the simulator, whose dataset the seed
		// generates again from the same seed and size, and whose changes the reset drops through its control endpoints.
		if (value.DEMO_MODE === true) {
			for (const name of ['FSP_MOCK_SEED', 'FSP_MOCK_ATHLETES', 'FSP_MOCK_CONTROL_TOKEN'] as const) {
				if (value[name] === undefined) {
					ctx.addIssue({ code: 'custom', path: [name], message: 'required when DEMO_MODE is true' });
				}
			}
			if (value.FSP_ACHIEVEMENTS_ADAPTER !== 'mock') {
				ctx.addIssue({
					code: 'custom',
					path: ['FSP_ACHIEVEMENTS_ADAPTER'],
					message: 'must be mock when DEMO_MODE is true (demonstration data live in the simulator)'
				});
			}
		}
		// The service token of `service_with_assertion` is a FSP ID client_credentials token (contracts 1.2, 1.8):
		// the achievements source cannot work without FSP ID, though FSP ID stands alone for login.
		if (value.FSP_ACHIEVEMENTS_ADAPTER !== undefined && value.FSP_ID_ISSUER === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['FSP_ID_ISSUER'],
				message: 'required when FSP_ACHIEVEMENTS_ADAPTER is set (FSP achievements needs a FSP ID service token)'
			});
		}
	});

type Env = z.infer<typeof envSchema>;

/** `baseUrl` is the server root without `/v1`: the adapter appends `/v1/<endpoint>`. */
export interface ExtractConfig {
	baseUrl: string;
	model: string;
	apiKey: string | null;
	/** Deadline of a background request. */
	timeoutMs: number;
	/** Deadline of an interactive call, waiting for a free slot included. */
	interactiveTimeoutMs: number;
	maxConcurrency: number;
	breaker: BreakerConfig;
}

export interface BreakerConfig {
	/** Failed calls in a row that open the breaker. */
	failures: number;
	/** How long an open breaker answers without calling the runtime. */
	cooldownMs: number;
}

export interface EmbedConfig {
	baseUrl: string;
	model: string;
	apiKey: string | null;
	spaceId: string;
	timeoutMs: number;
	interactiveTimeoutMs: number;
	batchSize: number;
	breaker: BreakerConfig;
}

export interface RerankConfig {
	baseUrl: string;
	model: string;
	apiKey: string | null;
	timeoutMs: number;
	interactiveTimeoutMs: number;
	topN: number;
	/** A longer query and document pair is cut by the runtime instead of failing the whole request. */
	truncateTokens: number;
	breaker: BreakerConfig;
}

export interface Config {
	databaseUrl: string;
	redisUrl: string;
	/** Public origin of the application: CSRF origin check, links in messages, OIDC redirect. */
	appOrigin: string;
	crypto: {
		/** Field encryption keys by version (1–255); the version is stored in each ciphertext. */
		fieldKeys: ReadonlyMap<number, Buffer>;
		activeFieldKeyVersion: number;
		hmacSecret: Buffer;
		/** Ed25519 private key seeds of receipt signatures by key id. */
		receiptSigningKeys: ReadonlyMap<string, Buffer>;
		activeReceiptSigningKeyId: string;
	};
	storage: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string };
	mail: { smtpUrl: string; from: string };
	docparse: { url: string };
	/**
	 * Code execution sandbox through its gateway (contracts 6). `maxConcurrentRuns` — runs one application process
	 * sends at once; one more is `busy` (contracts 6.2).
	 */
	sandbox: { url: string; maxConcurrentRuns: number };
	/** `null` — login through FSP ID is not configured. */
	fspId: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scopes: string } | null;
	/**
	 * `null` — achievements import is not configured. `webhookSecret` verifies incoming webhooks, `assertionSecret`
	 * signs consent assertions of the `service_with_assertion` grant (contracts 1.2).
	 */
	fspAchievements: {
		adapter: 'mock' | 'fsp-api';
		baseUrl: string;
		webhookSecret: string;
		assertionSecret: string;
	} | null;
	/** Each model operation is configured separately; `null` — the operation is disabled (contracts 3.1). */
	models: { extract: ExtractConfig | null; embed: EmbedConfig | null; rerank: RerankConfig | null };
	/** Public registry of the company verification hint; `null` — not configured, the hint says so (domain 5.2). */
	companyRegistry: 'egrul' | null;
	/** The Huntflow adapter of outgoing events; `null` — off: no connection is made and its deliveries are skipped. */
	huntflowApiUrl: string | null;
	/**
	 * Public APIs the verified public profiles are read from (domain 9.4): the real ones unless a stand points them
	 * elsewhere. `githubToken` — without it GitHub allows 60 requests an hour from the address.
	 */
	publicProfiles: { codeforcesApiUrl: string; githubApiUrl: string; githubToken: string | null };
	/** `null` — the Telegram channel is disabled (contracts 8.2). */
	telegram: { botToken: string; botUsername: string; webhookSecret: string } | null;
	/**
	 * The bootstrap administrator (domain 4.1): the account `build/admin/main.js ensure` creates or confirms at the start
	 * of the application; `null` — not configured. `password` is needed to create the account or reset its password and
	 * is removed from the environment after the first start (`null`); it is checked against the password rules there,
	 * not here.
	 */
	bootstrapAdmin: { email: string; password: string | null } | null;
	/**
	 * Demonstration mode (`DEMO_MODE=true`): the only mode in which the demo seed and the demo reset run, because both
	 * rewrite the whole database. `null` — off. `world` is the simulator's dataset (its seed and number of athletes), which
	 * the seed generates again to pick the athletes it links; `fspMockControlToken` opens the simulator's control
	 * endpoints for the reset. `nightlyReset` (`DEMO_NIGHTLY_RESET`, on by default): the worker resets the stand every
	 * night at 00:00 UTC and a demo session ends no later than that; off — nothing resets the stand by itself, a session
	 * lives to its own end or its idle time, and the operator cleans the stand by hand (docs/deploy.md).
	 */
	demo: {
		candidates: number;
		vacancies: number;
		nightlyReset: boolean;
		world: { seed: string; athletes: number };
		fspMockControlToken: string;
	} | null;
}

export class ConfigError extends Error {
	override name = 'ConfigError';
}

function present<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new ConfigError(`Invalid environment: ${name} is missing`);
	return value;
}

function build(e: Env): Config {
	return {
		databaseUrl: e.DATABASE_URL,
		redisUrl: e.REDIS_URL,
		appOrigin: new URL(e.APP_ORIGIN).origin,
		crypto: {
			fieldKeys: new Map([...e.FIELD_ENCRYPTION_KEYS].map(([version, key]) => [Number(version), key])),
			activeFieldKeyVersion: Number(e.FIELD_ENCRYPTION_ACTIVE_KEY),
			hmacSecret: e.FIELD_HMAC_SECRET,
			receiptSigningKeys: e.RECEIPT_SIGNING_KEYS,
			activeReceiptSigningKeyId: e.RECEIPT_ACTIVE_SIGNING_KEY
		},
		storage: {
			endpoint: e.S3_ENDPOINT,
			region: e.S3_REGION,
			accessKeyId: e.S3_ACCESS_KEY_ID,
			secretAccessKey: e.S3_SECRET_ACCESS_KEY,
			bucket: e.S3_BUCKET
		},
		mail: { smtpUrl: e.SMTP_URL, from: e.MAIL_FROM },
		docparse: { url: e.DOCPARSE_URL },
		sandbox: { url: e.SANDBOX_URL, maxConcurrentRuns: e.SANDBOX_MAX_CONCURRENT_RUNS ?? 2 },
		fspId: e.FSP_ID_ISSUER
			? {
					issuer: e.FSP_ID_ISSUER,
					clientId: present(e.FSP_ID_CLIENT_ID, 'FSP_ID_CLIENT_ID'),
					clientSecret: present(e.FSP_ID_CLIENT_SECRET, 'FSP_ID_CLIENT_SECRET'),
					redirectUri: present(e.FSP_ID_REDIRECT_URI, 'FSP_ID_REDIRECT_URI'),
					scopes: e.FSP_ID_SCOPES ?? 'openid profile email'
				}
			: null,
		companyRegistry: e.COMPANY_REGISTRY ?? null,
		huntflowApiUrl: e.HUNTFLOW_API_URL?.replace(/\/+$/, '') ?? null,
		publicProfiles: {
			codeforcesApiUrl: (e.CODEFORCES_API_URL ?? 'https://codeforces.com/api').replace(/\/+$/, ''),
			githubApiUrl: (e.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
			githubToken: e.GITHUB_TOKEN ?? null
		},
		fspAchievements: e.FSP_ACHIEVEMENTS_ADAPTER
			? {
					adapter: e.FSP_ACHIEVEMENTS_ADAPTER,
					baseUrl: present(e.FSP_ACHIEVEMENTS_BASE_URL, 'FSP_ACHIEVEMENTS_BASE_URL'),
					webhookSecret: present(e.FSP_WEBHOOK_SECRET, 'FSP_WEBHOOK_SECRET'),
					assertionSecret: present(e.FSP_ASSERTION_SECRET, 'FSP_ASSERTION_SECRET')
				}
			: null,
		models: {
			extract: e.LLM_BASE_URL
				? {
						baseUrl: e.LLM_BASE_URL,
						model: present(e.LLM_MODEL, 'LLM_MODEL'),
						apiKey: e.LLM_API_KEY ?? null,
						...deadlines('extract', e.LLM_TIMEOUT_MS, e.LLM_INTERACTIVE_TIMEOUT_MS),
						maxConcurrency: e.LLM_MAX_CONCURRENCY ?? LLM_DEFAULT_MAX_CONCURRENCY,
						breaker: breaker(e.LLM_BREAKER_FAILURES, e.LLM_BREAKER_COOLDOWN_MS)
					}
				: null,
			embed: e.EMBED_BASE_URL
				? {
						baseUrl: e.EMBED_BASE_URL,
						model: present(e.EMBED_MODEL, 'EMBED_MODEL'),
						apiKey: e.EMBED_API_KEY ?? null,
						spaceId: present(e.EMBED_SPACE_ID, 'EMBED_SPACE_ID'),
						...deadlines('embed', e.EMBED_TIMEOUT_MS, e.EMBED_INTERACTIVE_TIMEOUT_MS),
						batchSize: e.EMBED_BATCH_SIZE ?? 32,
						breaker: breaker(e.EMBED_BREAKER_FAILURES, e.EMBED_BREAKER_COOLDOWN_MS)
					}
				: null,
			rerank: e.RERANK_BASE_URL
				? {
						baseUrl: e.RERANK_BASE_URL,
						model: present(e.RERANK_MODEL, 'RERANK_MODEL'),
						apiKey: e.RERANK_API_KEY ?? null,
						...deadlines('rerank', e.RERANK_TIMEOUT_MS, e.RERANK_INTERACTIVE_TIMEOUT_MS),
						topN: e.RERANK_TOP_N ?? 50,
						truncateTokens: e.RERANK_TRUNCATE_TOKENS ?? RERANK_DEFAULT_TRUNCATE_TOKENS,
						breaker: breaker(e.RERANK_BREAKER_FAILURES, e.RERANK_BREAKER_COOLDOWN_MS)
					}
				: null
		},
		telegram: e.TELEGRAM_BOT_TOKEN
			? {
					botToken: e.TELEGRAM_BOT_TOKEN,
					botUsername: present(e.TELEGRAM_BOT_USERNAME, 'TELEGRAM_BOT_USERNAME'),
					webhookSecret: present(e.TELEGRAM_WEBHOOK_SECRET, 'TELEGRAM_WEBHOOK_SECRET')
				}
			: null,
		bootstrapAdmin: e.BOOTSTRAP_ADMIN_EMAIL
			? {
					email: e.BOOTSTRAP_ADMIN_EMAIL,
					password: e.BOOTSTRAP_ADMIN_PASSWORD ?? null
				}
			: null,
		demo:
			e.DEMO_MODE === true
				? {
						candidates: e.DEMO_CANDIDATES ?? 1000,
						vacancies: e.DEMO_VACANCIES ?? 300,
						nightlyReset: e.DEMO_NIGHTLY_RESET ?? true,
						world: {
							seed: present(e.FSP_MOCK_SEED, 'FSP_MOCK_SEED'),
							athletes: present(e.FSP_MOCK_ATHLETES, 'FSP_MOCK_ATHLETES')
						},
						fspMockControlToken: present(e.FSP_MOCK_CONTROL_TOKEN, 'FSP_MOCK_CONTROL_TOKEN')
					}
				: null
	};
}

/**
 * Validates the environment. Messages name the variables only: values may be secrets.
 */
export function parseConfig(source: Record<string, string | undefined>): Config {
	const result = envSchema.safeParse(source);
	if (!result.success) {
		const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
		throw new ConfigError(`Invalid environment:\n  ${problems.join('\n  ')}`);
	}
	return build(result.data);
}

let cached: Config | undefined;

/** Validated configuration, read on first use so that `vite build` does not need the runtime environment. */
export function config(): Config {
	cached ??= parseConfig(env);
	return cached;
}
