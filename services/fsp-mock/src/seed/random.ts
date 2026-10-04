import { createHash } from 'node:crypto';

/** Deterministic PRNG (sfc32) seeded from a string: the same seed always yields the same dataset. */
export class Random {
	#a: number;
	#b: number;
	#c: number;
	#d: number;

	constructor(seed: string) {
		const h = createHash('sha256').update(seed).digest();
		this.#a = h.readUInt32LE(0);
		this.#b = h.readUInt32LE(4);
		this.#c = h.readUInt32LE(8);
		this.#d = h.readUInt32LE(12);
		for (let i = 0; i < 16; i++) this.next();
	}

	/** Uniform float in [0, 1). */
	next(): number {
		const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
		this.#d = (this.#d + 1) | 0;
		this.#a = this.#b ^ (this.#b >>> 9);
		this.#b = (this.#c + (this.#c << 3)) | 0;
		this.#c = (this.#c << 21) | (this.#c >>> 11);
		this.#c = (this.#c + t) | 0;
		return (t >>> 0) / 4294967296;
	}

	/** Integer in [min, max]. */
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}

	chance(p: number): boolean {
		return this.next() < p;
	}

	pick<T>(items: readonly T[]): T {
		const item = items[Math.floor(this.next() * items.length)];
		if (item === undefined) throw new Error('pick from an empty list');
		return item;
	}

	/** Weighted choice; weights need not sum to one. */
	weighted<T>(items: readonly (readonly [T, number])[]): T {
		const total = items.reduce((sum, [, w]) => sum + w, 0);
		let r = this.next() * total;
		for (const [item, w] of items) {
			r -= w;
			if (r < 0) return item;
		}
		const last = items.at(-1);
		if (last === undefined) throw new Error('weighted choice from an empty list');
		return last[0];
	}

	/** Standard normal via Box–Muller. */
	normal(): number {
		const u = 1 - this.next();
		const v = this.next();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}

	shuffle<T>(items: T[]): T[] {
		for (let i = items.length - 1; i > 0; i--) {
			const j = Math.floor(this.next() * (i + 1));
			const a = items[i] as T;
			items[i] = items[j] as T;
			items[j] = a;
		}
		return items;
	}

	/** RFC 4122 version 4 layout filled from the PRNG (Keycloak subjects are UUIDs). */
	uuid(): string {
		const bytes = Array.from({ length: 16 }, () => this.int(0, 255));
		bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
		bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
		const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
}
