import { describe, expect, it, vi } from 'vitest';
import type { RateLimitStore } from '$lib/server/http/rate-limit';
import { ok } from '$lib/server/ml/result';
import type { VacancyLexicon } from '$lib/server/ml/vacancy-extract';
import { budgetedExtractor, STAND_BUDGET_SPENT, type PaidExtractor, type StandParseBudget } from './parse-budget';

function memoryStore(): RateLimitStore {
	const counts = new Map<string, number>();
	return {
		hit(key, windowSeconds) {
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			return Promise.resolve({ count, resetSeconds: windowSeconds });
		}
	};
}

/** A model that answers every call, counting them; `configured: false` — a configuration without the model. */
function model(configured = true): PaidExtractor & { calls: number } {
	const extractor = {
		calls: 0,
		extract: () => {
			extractor.calls++;
			return Promise.resolve(
				ok({
					model: { modelId: 'extractor-test', modelRevision: null, runtime: 'api' as const, params: {} },
					items: [],
					rejected: [],
					attempts: 1,
					latencyMs: 5
				})
			);
		},
		extractModelKey: () => Promise.resolve(configured ? 'api:extractor-test' : null)
	};
	return extractor;
}

const request = {
	schemaVersion: 'vacancy-extract/v2' as const,
	input: { type: 'vacancy' as const, id: 'v-1', revision: 0 },
	taxonomyVersionId: 't-1',
	blocks: [{ id: 'b1', text: 'Ищем Go-разработчика' }]
};
/** The lexicon is the model's business; the budget passes it on unread. */
const lexicon = {} as VacancyLexicon;

const budget = (limit: number, store = memoryStore()): StandParseBudget => ({
	limit: () => limit,
	store: () => Promise.resolve(store),
	waitMs: 1_000
});

describe('the budget of the stand', () => {
	it('calls the model up to the budget, then answers rate_limited without a call, not to be retried', async () => {
		const answering = model();
		const extractor = budgetedExtractor(answering, budget(2));
		expect((await extractor.extract(request, lexicon)).ok).toBe(true);
		expect((await extractor.extract(request, lexicon)).ok).toBe(true);
		const over = await extractor.extract(request, lexicon);
		expect(over).toMatchObject({
			ok: false,
			error: { code: 'rate_limited', retryable: false, details: { reason: STAND_BUDGET_SPENT } }
		});
		expect(answering.calls).toBe(2);
	});

	it('is shared by every extractor over the same counter: the app and the worker together', async () => {
		const store = memoryStore();
		const app = model();
		const worker = model();
		expect((await budgetedExtractor(app, budget(1, store)).extract(request, lexicon)).ok).toBe(true);
		expect((await budgetedExtractor(worker, budget(1, store)).extract(request, lexicon)).ok).toBe(false);
		expect(worker.calls).toBe(0);
	});

	it('does not count a call while the model is off, and refuses when the counter cannot be read', async () => {
		const off = model(false);
		const offBudget = budget(0);
		await budgetedExtractor(off, offBudget).extract(request, lexicon);
		expect(off.calls).toBe(1);

		const answering = model();
		const broken: StandParseBudget = {
			limit: () => 10,
			store: () => Promise.reject(new Error('redis is down')),
			waitMs: 1_000
		};
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const answer = await budgetedExtractor(answering, broken).extract(request, lexicon);
			expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable', details: { cause: 'budget_store' } } });
			expect(logged).toHaveBeenCalledOnce();
		} finally {
			logged.mockRestore();
		}
		expect(answering.calls).toBe(0);
	});
});
