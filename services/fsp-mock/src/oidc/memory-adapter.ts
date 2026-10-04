// Storage of the simulated provider: process memory by design. A restart drops sessions and tokens, and the
// platform signs in again, which is what a stand needs.

import type { Adapter, AdapterPayload } from 'oidc-provider';

interface Stored {
	payload: AdapterPayload;
	expiresAt: number;
}

const SWEEP_EVERY = 500;

/** One store per provider instance, shared by all its models (keys are prefixed with the model name). */
export function memoryAdapterFactory(): (model: string) => Adapter {
	const store = new Map<string, Stored>();
	const grantIndex = new Map<string, Set<string>>();
	let writes = 0;

	const alive = (key: string): AdapterPayload | undefined => {
		const entry = store.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			store.delete(key);
			return undefined;
		}
		return entry.payload;
	};

	const sweep = () => {
		const now = Date.now();
		for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key);
	};

	return (model: string): Adapter => {
		const key = (id: string) => `${model}:${id}`;
		const lookup = (index: string) => {
			const ref = alive(index);
			return typeof ref?.id === 'string' ? alive(key(ref.id)) : undefined;
		};
		return {
			upsert(id, payload, expiresIn) {
				const expiresAt = expiresIn === undefined ? Number.POSITIVE_INFINITY : Date.now() + expiresIn * 1000;
				store.set(key(id), { payload, expiresAt });
				if (payload.grantId) {
					const keys = grantIndex.get(payload.grantId) ?? new Set<string>();
					keys.add(key(id));
					grantIndex.set(payload.grantId, keys);
				}
				if (payload.userCode) store.set(`${model}:userCode:${payload.userCode}`, { payload: { id }, expiresAt });
				if (payload.uid) store.set(`${model}:uid:${payload.uid}`, { payload: { id }, expiresAt });
				if (++writes % SWEEP_EVERY === 0) sweep();
				return Promise.resolve();
			},
			find: (id) => Promise.resolve(alive(key(id))),
			findByUserCode: (userCode) => Promise.resolve(lookup(`${model}:userCode:${userCode}`)),
			findByUid: (uid) => Promise.resolve(lookup(`${model}:uid:${uid}`)),
			consume(id) {
				const payload = alive(key(id));
				if (payload) payload.consumed = Math.floor(Date.now() / 1000);
				return Promise.resolve();
			},
			destroy(id) {
				store.delete(key(id));
				return Promise.resolve();
			},
			revokeByGrantId(grantId) {
				for (const k of grantIndex.get(grantId) ?? []) store.delete(k);
				grantIndex.delete(grantId);
				return Promise.resolve();
			}
		};
	};
}
