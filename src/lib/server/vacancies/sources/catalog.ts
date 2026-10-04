// The adapter of each source key of the catalog (sources/definitions.ts, docs/domain.md, section 13.2).
import { HabrCareerSource } from './habr';
import type { FetchLike } from './http';
import { HABR_SOURCE_KEY, TRUDVSEM_SOURCE_KEY } from './definitions';
import { TrudvsemSource } from './trudvsem';
import type { VacancySource } from './types';

export interface SourceFactoryDeps {
	fetch: FetchLike;
	userAgent: string;
	timeoutMs: number;
	now: () => Date;
}

/** The adapter of a source; `null` — the product has no adapter for this key. */
export function createVacancySource(key: string, deps: SourceFactoryDeps, signal?: AbortSignal): VacancySource | null {
	const http = {
		fetch: deps.fetch,
		userAgent: deps.userAgent,
		timeoutMs: deps.timeoutMs,
		...(signal ? { signal } : {})
	};
	switch (key) {
		case HABR_SOURCE_KEY:
			return new HabrCareerSource({ http, now: deps.now });
		case TRUDVSEM_SOURCE_KEY:
			return new TrudvsemSource({ http, now: deps.now });
		default:
			return null;
	}
}
