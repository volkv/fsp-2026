// The administrator's run-time switch of a model operation: the switch goes through `can`, is journaled as
// `ml.mode_changed` and takes effect at once — the adapter answers `disabled` with `switched_off` without calling the
// runtime, in this process immediately and in another process within the cache lifetime.
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { modelsOverview, parseModeSwitch, switchModelMode } from '$lib/server/admin/models';
import { auditEvents, mlResults } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { ModelAdapter } from '$lib/server/ml/adapter';
import { ModelModes } from '$lib/server/ml/modes';
import { databaseSpaceLookup } from '$lib/server/ml/spaces';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createUser, randomSha256 } from '../helpers/factories';

// Redis is shared by the test files; the switch keys are fixed, so this file keeps them in a logical database of its own.
const REDIS_DATABASE = 7;

let database: TestDatabase;
let redis: ReturnType<typeof createClient>;
let adminId: string;
let operatorId: string;

/** The journal is append-only: each test finds its own entries by its request id. */
let meta: { requestId: string; ip: string; userAgent: string };

const subject = (userId: string, staff: Partial<AccessSubject['staff']>): AccessSubject => ({
	userId,
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: false, admin: false, extraPermissions: [], ...staff }
});

function clock() {
	let now = 1_000_000;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		}
	};
}

function modes(now?: () => number) {
	return new ModelModes({
		client: () => Promise.resolve(redis),
		database: () => database.db,
		cacheTtlMs: 2_000,
		...(now ? { now } : {})
	});
}

/** `extract` configured against an address nobody listens on: a switched-off call never reaches it. */
function adapter(switcher: ModelModes) {
	return new ModelAdapter({
		models: {
			extract: {
				baseUrl: 'http://127.0.0.1:9',
				model: 'extractor-7b',
				apiKey: 'secret-key',
				timeoutMs: 1_000,
				interactiveTimeoutMs: 1_000,
				maxConcurrency: 1,
				breaker: { failures: 3, cooldownMs: 30_000 }
			},
			embed: null,
			rerank: null
		},
		modes: switcher,
		spaces: databaseSpaceLookup(() => database.db)
	});
}

const REQUEST = {
	input: { type: 'document_extraction', id: 'extraction-1' },
	schemaVersion: 'resume-extract/v2',
	taxonomyVersionId: 'taxonomy-1',
	blocks: [{ id: 'p1-b001', text: 'Go, PostgreSQL' }]
} as const;
const lexicon = { aliasesOf: () => [] };

async function journal() {
	return database.db
		.select()
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'ml.mode_changed'), eq(auditEvents.requestId, meta.requestId)));
}

beforeAll(async () => {
	database = await createTestDatabase();
	redis = createClient({ url: inject('redisUrl'), database: REDIS_DATABASE });
	await redis.connect();
	adminId = (await createUser(database.db)).id;
	operatorId = (await createUser(database.db)).id;
});

afterAll(async () => {
	await redis.flushDb();
	redis.destroy();
	await database.drop();
});

beforeEach(async () => {
	await redis.del(['ml:mode:extract', 'ml:mode:embed', 'ml:mode:rerank']);
	meta = { requestId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' };
});

describe('switching a model operation', () => {
	it('switches extract off and on for the administrator, journaled, effective at once', async () => {
		const time = clock();
		const page = modes(time.now);
		const worker = modes(time.now);
		const models = adapter(page);
		const workerModels = adapter(worker);
		const ctx = { subject: subject(adminId, { admin: true }), meta };
		// The other process has read the mode before the switch and caches it.
		expect(await worker.current('extract')).toEqual({ ok: true, value: 'on' });

		expect(await switchModelMode({ modes: page }, ctx, { operation: 'extract', mode: 'off' })).toEqual({
			changed: true,
			previous: 'on'
		});
		expect(await models.extract(REQUEST, lexicon)).toMatchObject({
			ok: false,
			error: { code: 'disabled', retryable: false, details: { reason: 'switched_off' } }
		});
		time.advance(2_001);
		expect(await workerModels.extract(REQUEST, lexicon)).toMatchObject({
			ok: false,
			error: { code: 'disabled', details: { reason: 'switched_off' } }
		});

		const [entry] = await journal();
		expect(entry).toMatchObject({
			outcome: 'success',
			actorKind: 'user',
			actorUserId: adminId,
			objectType: 'model_operation',
			requestId: meta.requestId,
			details: { operation: 'extract', from: 'on', to: 'off' }
		});

		await switchModelMode({ modes: page }, ctx, { operation: 'extract', mode: 'on' });
		expect(await page.current('extract')).toEqual({ ok: true, value: 'on' });
		const details = (await journal()).map((row) => row.details);
		expect(details).toHaveLength(2);
		expect(details).toEqual(
			expect.arrayContaining([
				{ operation: 'extract', from: 'on', to: 'off' },
				{ operation: 'extract', from: 'off', to: 'on' }
			])
		);
	});

	it('refuses the switch to anyone without the administrator role and changes nothing', async () => {
		const page = modes();
		const ctx = { subject: subject(operatorId, { operator: true, extraPermissions: ['audit.read'] }), meta };
		await expect(switchModelMode({ modes: page }, ctx, { operation: 'extract', mode: 'off' })).rejects.toMatchObject({
			code: 'forbidden'
		});
		expect(await redis.get('ml:mode:extract')).toBeNull();
		expect(await journal()).toHaveLength(0);
	});

	it('accepts only a known operation and mode from the form', () => {
		const form = new FormData();
		form.set('operation', 'explain_text');
		form.set('mode', 'off');
		expect(() => parseModeSwitch(form)).toThrow(ApiError);
		form.set('operation', 'embed');
		expect(parseModeSwitch(form)).toEqual({ operation: 'embed', mode: 'off' });
	});
});

describe('models overview', () => {
	it('shows the settings without secrets, the mode and the latest calls without the model', async () => {
		const page = modes();
		await page.set({ operation: 'embed', mode: 'off', actor: { kind: 'user', userId: adminId }, requestId: 'r' });
		await database.db.insert(mlResults).values({
			operation: 'extract',
			inputRef: { type: 'document_extraction', id: 'x' },
			inputSha256: randomSha256(),
			inputVersion: '1',
			schemaVersion: 'resume-extract/v2',
			processingMode: 'rules_only',
			rulesVersion: 'rules-1',
			failure: { code: 'timeout', retryable: true }
		});
		const overview = await modelsOverview(
			{
				db: database.db,
				modes: page,
				models: {
					extract: {
						baseUrl: 'http://llm.internal:8000',
						model: 'extractor-7b',
						apiKey: 'secret-key',
						timeoutMs: 120_000,
						interactiveTimeoutMs: 30_000,
						maxConcurrency: 2,
						breaker: { failures: 3, cooldownMs: 30_000 }
					},
					embed: null,
					rerank: null
				},
				now: () => new Date()
			},
			{ subject: subject(adminId, { admin: true }), meta }
		);
		const byOperation = Object.fromEntries(overview.operations.map((state) => [state.operation, state]));
		expect(byOperation.extract).toMatchObject({ mode: 'on', effective: 'model', lastDay: { rules_only: 1 } });
		expect(JSON.stringify(byOperation.extract?.settings)).not.toContain('secret-key');
		expect(byOperation.extract?.settings).toContainEqual({ label: 'Рантайм', value: 'llm.internal:8000' });
		expect(byOperation.embed).toMatchObject({ mode: 'off', effective: 'not_configured', settings: null });
		expect(overview.problems[0]).toMatchObject({
			operation: 'extract',
			processingMode: 'rules_only',
			code: 'timeout',
			inputType: 'document_extraction'
		});
	});
});
