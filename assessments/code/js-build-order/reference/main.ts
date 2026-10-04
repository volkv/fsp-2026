import { readFileSync } from 'node:fs';

const { packages } = JSON.parse(readFileSync(0, 'utf8')) as { packages: Record<string, string[]> };
const names = Object.keys(packages);
const known = new Set(names);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Binary min-heap of names. */
class MinHeap {
	readonly #items: string[] = [];

	get size(): number {
		return this.#items.length;
	}

	#at(index: number): string {
		const value = this.#items[index];
		if (value === undefined) throw new RangeError(`heap index ${index} is empty`);
		return value;
	}

	push(value: string): void {
		const items = this.#items;
		items.push(value);
		let index = items.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (this.#at(parent) <= value) break;
			items[index] = this.#at(parent);
			index = parent;
		}
		items[index] = value;
	}

	pop(): string {
		const top = this.#at(0);
		const last = this.#at(this.#items.length - 1);
		this.#items.pop();
		const items = this.#items;
		if (items.length > 0) {
			let index = 0;
			for (;;) {
				const left = 2 * index + 1;
				if (left >= items.length) break;
				const child = left + 1 < items.length && this.#at(left + 1) < this.#at(left) ? left + 1 : left;
				if (this.#at(child) >= last) break;
				items[index] = this.#at(child);
				index = child;
			}
			items[index] = last;
		}
		return top;
	}
}

const dependenciesOf = (name: string): Set<string> => new Set(packages[name] ?? []);

const missing: [string, string][] = [];
for (const name of names) {
	for (const dependency of dependenciesOf(name)) {
		if (!known.has(dependency)) missing.push([name, dependency]);
	}
}

if (missing.length > 0) {
	missing.sort((x, y) => compare(x[0], y[0]) || compare(x[1], y[1]));
	console.log(missing.map(([name, dependency]) => `MISSING ${name} -> ${dependency}`).join('\n'));
} else {
	const waiting = new Map<string, number>();
	const dependents = new Map<string, string[]>(names.map((name) => [name, []]));
	for (const name of names) {
		const unique = dependenciesOf(name);
		waiting.set(name, unique.size);
		for (const dependency of unique) dependents.get(dependency)?.push(name);
	}
	const ready = new MinHeap();
	for (const name of names) if (waiting.get(name) === 0) ready.push(name);
	const order: string[] = [];
	while (ready.size > 0) {
		const name = ready.pop();
		order.push(name);
		for (const dependent of dependents.get(name) ?? []) {
			const left = (waiting.get(dependent) ?? 0) - 1;
			waiting.set(dependent, left);
			if (left === 0) ready.push(dependent);
		}
	}
	if (order.length < names.length) {
		const built = new Set(order);
		order.push(
			`CYCLE: ${names
				.filter((name) => !built.has(name))
				.sort()
				.join(' ')}`
		);
	}
	console.log(order.join('\n'));
}
