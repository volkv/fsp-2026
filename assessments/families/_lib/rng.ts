// A deterministic pseudo-random stream for generators: the same seed string always gives the same sequence, on any
// machine and in any process. xoshiro128** seeded from SHA-256 of the seed string.
import { createHash } from 'node:crypto';

export class Rng {
	readonly #state: Uint32Array;

	constructor(seed: string) {
		const digest = createHash('sha256').update(seed).digest();
		this.#state = new Uint32Array([
			digest.readUInt32LE(0),
			digest.readUInt32LE(4),
			digest.readUInt32LE(8),
			digest.readUInt32LE(12)
		]);
		if (this.#state.every((word) => word === 0)) this.#state[0] = 1;
	}

	/** A 32-bit unsigned integer. */
	#nextUint32(): number {
		const s = this.#state;
		const s0 = s[0] ?? 0;
		const s1 = s[1] ?? 0;
		const s2 = s[2] ?? 0;
		const s3 = s[3] ?? 0;
		const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
		const t = (s1 << 9) >>> 0;
		const n2 = (s2 ^ s0) >>> 0;
		const n3 = (s3 ^ s1) >>> 0;
		const n1 = (s1 ^ n2) >>> 0;
		const n0 = (s0 ^ n3) >>> 0;
		s[0] = n0;
		s[1] = n1;
		s[2] = (n2 ^ t) >>> 0;
		s[3] = rotl(n3, 11);
		return result;
	}

	/** A float in [0, 1). */
	next(): number {
		return this.#nextUint32() / 4294967296;
	}

	/** An integer in [min, max], both ends included. */
	int(min: number, max: number): number {
		if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new Error(`rng.int(${min}, ${max})`);
		return min + Math.floor(this.next() * (max - min + 1));
	}

	bool(probability = 0.5): boolean {
		return this.next() < probability;
	}

	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new Error('rng.pick of an empty list');
		return items[this.int(0, items.length - 1)] as T;
	}

	/** A shuffled copy (Fisher–Yates). */
	shuffle<T>(items: readonly T[]): T[] {
		const copy = [...items];
		for (let i = copy.length - 1; i > 0; i -= 1) {
			const j = this.int(0, i);
			[copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
		}
		return copy;
	}

	/** `count` distinct items in random order. */
	sample<T>(items: readonly T[], count: number): T[] {
		if (count > items.length) throw new Error(`rng.sample of ${count} from ${items.length}`);
		return this.shuffle(items).slice(0, count);
	}
}

function rotl(value: number, shift: number): number {
	return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}
