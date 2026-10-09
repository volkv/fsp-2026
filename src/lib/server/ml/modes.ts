// Run-time switch of each model operation. An administrator turns an operation off while the application runs, and
// every process sees the change within the cache lifetime, without a restart. A switched-off operation answers
// `disabled` (reason `switched_off`); the caller takes the product's no-model path (docs/contracts.md, section 3.5).
import { withTimeout } from '$lib/server/async/timeout';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import type { Database } from '$lib/server/db';
import type { Redis } from '$lib/server/redis';
import { MODEL_OPERATIONS, fail, ok, type ModelOperation, type ModelResult } from './result';
import { loggedError } from '$lib/server/db/errors';

export type ModelMode = 'on' | 'off';

/** An operation without a stored mode is on: the configuration alone decides. */
const DEFAULT_MODE: ModelMode = 'on';

const DEFAULT_CACHE_TTL_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 1_000;

export type ModeStoreClient = Pick<Redis, 'mGet' | 'set'>;

export interface ModelModeChange {
	operation: ModelOperation;
	mode: ModelMode;
	actor: AuditActor;
	requestId: string;
	ip?: string | null;
	userAgent?: string | null;
}

export interface ModelModesOptions {
	client: () => Promise<ModeStoreClient>;
	/** The database of the action journal: every switch is recorded as `ml.mode_changed`. */
	database: () => Database;
	cacheTtlMs?: number;
	/** Bound on waiting for the store; Redis that is reconnecting would otherwise hold the call. */
	readTimeoutMs?: number;
	now?: () => number;
}

function keyOf(operation: ModelOperation): string {
	return `ml:mode:${operation}`;
}

function parseMode(operation: ModelOperation, stored: string | null): ModelMode {
	if (stored === null) return DEFAULT_MODE;
	if (stored === 'on' || stored === 'off') return stored;
	throw new Error(`stored mode of ${operation} is not on/off`);
}

export class ModelModes {
	readonly #options: Required<ModelModesOptions>;
	#cache: { modes: Record<ModelOperation, ModelMode>; expiresAt: number } | null = null;
	#loading: Promise<Record<ModelOperation, ModelMode>> | null = null;

	constructor(options: ModelModesOptions) {
		this.#options = {
			cacheTtlMs: DEFAULT_CACHE_TTL_MS,
			readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
			now: Date.now,
			...options
		};
	}

	/**
	 * Current mode of the operation, cached for `cacheTtlMs`. A store that cannot be read is `unavailable`:
	 * the adapter neither guesses the mode nor calls a model an administrator may have switched off.
	 */
	async current(operation: ModelOperation): Promise<ModelResult<ModelMode>> {
		const modes = await this.list();
		return modes.ok ? ok(modes.value[operation]) : modes;
	}

	/** Modes of all operations, for the administration page. */
	async list(): Promise<ModelResult<Record<ModelOperation, ModelMode>>> {
		const { now, cacheTtlMs } = this.#options;
		const cached = this.#cache;
		if (cached && cached.expiresAt > now()) return ok(cached.modes);
		this.#loading ??= this.#load().finally(() => {
			this.#loading = null;
		});
		try {
			const modes = await this.#loading;
			this.#cache = { modes, expiresAt: now() + cacheTtlMs };
			return ok(modes);
		} catch (error) {
			console.error('[ml] model mode store unreadable', loggedError(error));
			return fail('unavailable', 'model mode store is unreadable', { cause: 'mode_store' });
		}
	}

	async #load(): Promise<Record<ModelOperation, ModelMode>> {
		const { client, readTimeoutMs } = this.#options;
		const stored = await withTimeout(
			client().then((redis) => redis.mGet(MODEL_OPERATIONS.map(keyOf))),
			readTimeoutMs,
			'model mode read'
		);
		const modes = {} as Record<ModelOperation, ModelMode>;
		MODEL_OPERATIONS.forEach((operation, index) => {
			modes[operation] = parseMode(operation, stored[index] ?? null);
		});
		return Object.freeze(modes);
	}

	/**
	 * Switches an operation and records `ml.mode_changed` in the action journal. One transaction: the journal entry is
	 * written first and the store last, so a journal failure leaves the mode unchanged and a store failure rolls the
	 * entry back. If the commit itself fails after the store write, the previous mode is restored before rethrowing.
	 * Returns the previous mode; setting the current mode again changes and records nothing.
	 */
	async set(change: ModelModeChange): Promise<{ previous: ModelMode; changed: boolean }> {
		const { client, database, readTimeoutMs } = this.#options;
		const redis = await withTimeout(client(), readTimeoutMs, 'model mode store connection');
		const key = keyOf(change.operation);
		const [stored] = await redis.mGet([key]);
		const previous = parseMode(change.operation, stored ?? null);
		if (previous === change.mode) return { previous, changed: false };

		const progress = { storeWritten: false };
		try {
			await database().transaction(async (tx) => {
				await recordAuditEvent(tx, {
					action: 'ml.mode_changed',
					outcome: 'success',
					actor: change.actor,
					object: { type: 'model_operation', id: change.operation },
					requestId: change.requestId,
					ip: change.ip ?? null,
					userAgent: change.userAgent ?? null,
					details: { operation: change.operation, from: previous, to: change.mode }
				});
				await redis.set(key, change.mode);
				progress.storeWritten = true;
			});
		} catch (error) {
			if (progress.storeWritten) {
				try {
					await redis.set(key, previous);
				} catch (restoreError) {
					throw new AggregateError([error, restoreError], 'model mode switched but not journaled; restore failed', {
						cause: restoreError
					});
				}
			}
			throw error;
		} finally {
			this.#cache = null;
		}
		return { previous, changed: true };
	}
}
