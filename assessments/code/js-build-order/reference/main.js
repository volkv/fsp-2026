import { readFileSync } from 'node:fs';

const { packages } = JSON.parse(readFileSync(0, 'utf8'));
const names = Object.keys(packages);
const known = new Set(names);

const missing = [];
for (const name of names) {
	for (const dependency of new Set(packages[name])) {
		if (!known.has(dependency)) missing.push([name, dependency]);
	}
}
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

if (missing.length > 0) {
	missing.sort((x, y) => compare(x[0], y[0]) || compare(x[1], y[1]));
	console.log(missing.map(([name, dependency]) => `MISSING ${name} -> ${dependency}`).join('\n'));
} else {
	const waiting = new Map();
	const dependents = new Map(names.map((name) => [name, []]));
	for (const name of names) {
		const unique = new Set(packages[name]);
		waiting.set(name, unique.size);
		for (const dependency of unique) dependents.get(dependency).push(name);
	}

	/** Binary min-heap of names. */
	const heap = [];
	const push = (value) => {
		heap.push(value);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (heap[parent] <= value) break;
			heap[index] = heap[parent];
			index = parent;
		}
		heap[index] = value;
	};
	const pop = () => {
		const top = heap[0];
		const last = heap.pop();
		if (heap.length > 0) {
			let index = 0;
			for (;;) {
				const left = 2 * index + 1;
				if (left >= heap.length) break;
				const child = left + 1 < heap.length && heap[left + 1] < heap[left] ? left + 1 : left;
				if (heap[child] >= last) break;
				heap[index] = heap[child];
				index = child;
			}
			heap[index] = last;
		}
		return top;
	};

	for (const name of names) if (waiting.get(name) === 0) push(name);
	const order = [];
	while (heap.length > 0) {
		const name = pop();
		order.push(name);
		for (const dependent of dependents.get(name)) {
			const left = waiting.get(dependent) - 1;
			waiting.set(dependent, left);
			if (left === 0) push(dependent);
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
