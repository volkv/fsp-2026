// The hourly budget of the stand for the calls of the extraction model by the parses visitors start — the text of a
// need or of a vacancy, an uploaded resume (docs/deploy.md, «Бюджет шлюза модели»). The budgets of an account and of
// an address (`http/rate-limit.ts`) bound one visitor; this one bounds all of them together, so that scripts from many
// addresses do not spend the month of the gateway in hours. Over the budget the model is not called: the parse answers
// `rate_limited` (reason `stand_budget`), as when the gateway itself answers `429`, and the product reads the text by
// the rules with that reason on the result. A kept answer to the same text (`vacancies/text-extract.ts`) calls no model
// and is not counted. The app and the worker share one counter in Redis.
import { withTimeout } from '$lib/server/async/timeout';
import { config } from '$lib/server/config';
import { loggedError } from '$lib/server/db/errors';
import { consume, redisRateLimitStore, type RateLimitStore } from '$lib/server/http/rate-limit';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { modelAdapter } from '$lib/server/ml';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { fail, type ModelError } from '$lib/server/ml/result';
import { redis } from '$lib/server/redis';

/** The extraction a visitor's parse calls. */
export type PaidExtractor = Pick<ModelAdapter, 'extract' | 'extractModelKey'>;

export interface StandParseBudget {
	/** Calls of the model an hour. */
	limit: () => number;
	store: () => Promise<RateLimitStore>;
	/** Bound on the wait for the counter. */
	waitMs: number;
}

/** The counter of the stand: one subject for every process. */
const STAND_RULE = 'model-parse';
const STAND_SUBJECT = 'stand';

/** Why a call within a spent budget is not made: the model answers nothing until the hour of the counter ends. */
export const STAND_BUDGET_SPENT = 'stand_budget';

/**
 * The refusal of a call over the budget. Not retried: a job that retries within the hour meets the same budget, so a
 * resume is read by the rules at once rather than after the job's attempts.
 */
function budgetSpent(limit: number): { ok: false; error: ModelError } {
	return {
		ok: false,
		error: {
			code: 'rate_limited',
			retryable: false,
			message: `extract: the stand has made its ${String(limit)} calls of this hour, not called`,
			details: { reason: STAND_BUDGET_SPENT }
		}
	};
}

/**
 * Counts the call against the budget: `null` — within it, the model may be called; otherwise the failure the parse
 * reads by the rules. A counter that cannot be read is `unavailable` — the call is not made unbounded.
 */
async function charge(budget: StandParseBudget): Promise<{ ok: false; error: ModelError } | null> {
	const limit = budget.limit();
	try {
		const store = await budget.store();
		const decision = await withTimeout(
			consume(store, { name: STAND_RULE, limit, windowSeconds: 3_600 }, STAND_SUBJECT),
			budget.waitMs,
			'parse budget counter'
		);
		return decision.allowed ? null : budgetSpent(limit);
	} catch (cause) {
		console.error('[parse-budget] counter unavailable, the model is not called', loggedError(cause));
		return fail('unavailable', 'extract: the budget of the stand cannot be read, not called', {
			cause: 'budget_store'
		});
	}
}

/**
 * The extraction of `models` behind the budget of the stand. When `extract` would call no model now (`extractModelKey`
 * `null`: not configured, no API key, switched off) the call is passed through uncounted: the adapter answers
 * `disabled` without a call, and the parse says so rather than the budget.
 */
export function budgetedExtractor(models: PaidExtractor, budget: StandParseBudget): PaidExtractor {
	return {
		extractModelKey: () => models.extractModelKey(),
		extract: async (request, lexicon, options) => {
			if ((await models.extractModelKey()) !== null) {
				const refused = await charge(budget);
				if (refused) return refused;
			}
			return models.extract(request, lexicon, options);
		}
	};
}

/** The models of the API services: the extraction behind the budget, the search models as they are. */
export function budgetedModels(
	models: MatchingModels & PaidExtractor,
	budget: StandParseBudget
): MatchingModels & PaidExtractor {
	return {
		embed: (request, options) => models.embed(request, options),
		rerank: (request, options) => models.rerank(request, options),
		...budgetedExtractor(models, budget)
	};
}

const REDIS_WAIT_MS = 1_000;

let configured: (MatchingModels & PaidExtractor) | undefined;

/** The model adapter of the process behind the configured budget of the stand (`PARSE_BUDGET_STAND`). */
export function paidModels(): MatchingModels & PaidExtractor {
	configured ??= budgetedModels(modelAdapter(), {
		limit: () => config().parseBudget.stand,
		store: async () => redisRateLimitStore(await withTimeout(redis(), REDIS_WAIT_MS, 'redis')),
		waitMs: REDIS_WAIT_MS
	});
	return configured;
}
