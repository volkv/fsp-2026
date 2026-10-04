// Source failures the simulator can reproduce on request (control endpoint `PUT /mock/faults`), so the platform's
// handling of section 1.3 (completeness) and 1.6 (errors) can be shown and tested.

import { HttpError } from '../http.ts';
import type { AthleteRecord, Store } from '../store.ts';
import type { AchievementsPage } from '../types.ts';

export const FAULT_MODES = [
	/** 503 `unavailable`. */
	'unavailable',
	/** 429 `rate_limited` with `Retry-After`. */
	'rate_limited',
	/** Pages declare `complete: false`. */
	'partial',
	/** Pages carry no `complete` field. */
	'no_completeness_signal',
	/** The athlete's data changes right after a page is served: the next page has another `sourceVersion`. */
	'version_changed',
	/** Results lose the required `status` field: a structural violation of the schema. */
	'malformed'
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export interface Fault {
	mode: FaultMode;
	/** `null` — every athlete. */
	athleteId: string | null;
	/** How many more achievement/athlete calls are affected; `null` — until cleared. */
	remaining: number | null;
}

const RETRY_AFTER_SECONDS = 2;

function without(value: object, key: string): object {
	return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

export class Faults {
	#faults: Fault[] = [];

	set(fault: Fault): void {
		this.#faults = [...this.#faults.filter((f) => f.athleteId !== fault.athleteId), fault];
	}

	clear(): void {
		this.#faults = [];
	}

	list(): readonly Fault[] {
		return this.#faults;
	}

	#take(athleteId: string, modes: readonly FaultMode[]): Fault | undefined {
		const fault = this.#faults.find(
			(f) => (f.athleteId === null || f.athleteId === athleteId) && modes.includes(f.mode)
		);
		if (fault?.remaining != null) {
			fault.remaining -= 1;
			if (fault.remaining <= 0) this.#faults = this.#faults.filter((f) => f !== fault);
		}
		return fault;
	}

	failIfActive(athleteId: string): void {
		const fault = this.#take(athleteId, ['unavailable', 'rate_limited']);
		if (fault?.mode === 'unavailable') throw new HttpError(503, 'unavailable', 'source is temporarily unavailable');
		if (fault?.mode === 'rate_limited') {
			throw new HttpError(429, 'rate_limited', 'too many requests', { 'retry-after': String(RETRY_AFTER_SECONDS) });
		}
	}

	/** The page as it goes on the wire; a fault may make it violate the schema on purpose. */
	shape(athleteId: string, page: AchievementsPage): object {
		const fault = this.#take(athleteId, ['partial', 'no_completeness_signal', 'malformed']);
		if (fault?.mode === 'partial') return { ...page, complete: false };
		if (fault?.mode === 'no_completeness_signal') return without(page, 'complete');
		if (fault?.mode === 'malformed') {
			return {
				...page,
				results: page.results.map((r) => without(r, 'status'))
			};
		}
		return page;
	}

	afterPage(athleteId: string, record: AthleteRecord, store: Store): void {
		if (this.#take(athleteId, ['version_changed'])) store.touch(record);
	}
}
