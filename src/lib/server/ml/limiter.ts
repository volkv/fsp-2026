// Bounds concurrent requests to one runtime (the GPU host of `extract` serves `LLM_MAX_CONCURRENCY` requests at a time).
// Interactive callers are served before background ones; a waiter leaves the queue when its signal aborts.

export type CallPriority = 'interactive' | 'background';

interface Waiter {
	grant: () => void;
}

export class ConcurrencyLimiter {
	readonly #capacity: number;
	#active = 0;
	readonly #queues: Record<CallPriority, Waiter[]> = { interactive: [], background: [] };

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`invalid concurrency ${capacity}`);
		this.#capacity = capacity;
	}

	get active(): number {
		return this.#active;
	}

	get waiting(): number {
		return this.#queues.interactive.length + this.#queues.background.length;
	}

	/**
	 * Resolves with a release function once a slot is free, or with `null` when `signal` aborts first.
	 * The release function must be called exactly once.
	 */
	acquire(priority: CallPriority, signal: AbortSignal): Promise<(() => void) | null> {
		if (signal.aborted) return Promise.resolve(null);
		if (this.#active < this.#capacity) {
			this.#active++;
			return Promise.resolve(this.#releaser());
		}
		return new Promise((resolve) => {
			const queue = this.#queues[priority];
			const waiter: Waiter = {
				grant: () => {
					signal.removeEventListener('abort', onAbort);
					resolve(this.#releaser());
				}
			};
			const onAbort = () => {
				const index = queue.indexOf(waiter);
				if (index >= 0) queue.splice(index, 1);
				resolve(null);
			};
			signal.addEventListener('abort', onAbort, { once: true });
			queue.push(waiter);
		});
	}

	#releaser(): () => void {
		let released = false;
		return () => {
			if (released) throw new Error('concurrency slot released twice');
			released = true;
			const next = this.#queues.interactive.shift() ?? this.#queues.background.shift();
			// The slot passes straight to the next waiter; `active` stays the same.
			if (next) next.grant();
			else this.#active--;
		};
	}
}
