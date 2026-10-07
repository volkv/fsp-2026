// Channels between coroutines in a single-threaded `runBlocking`: when `send` suspends (rendezvous, a buffer of a
// given capacity, CONFLATED, UNLIMITED), what `trySend` reports, how `close` ends a `for` over the channel after the
// buffered elements, how cancelling a `produce` channel stops its producer, and how two consumers share one channel.
// The kind of the channel and the shape of the exchange are the essential class; names, values and their count are
// surface. The order of events comes from the queue of the event loop only — no delays.
//
// The model runs the program as JavaScript generators on a model of the event loop: a FIFO queue of dispatched
// coroutines; `send` hands the element to the first waiting receiver (dispatching it) and goes on, or buffers it while
// there is room, or suspends; `receive` takes the head of the buffer and moves the first suspended sender's element
// into it (dispatching that sender), or takes the element of a suspended sender directly; `close` dispatches every
// waiting receiver with the end of the channel; a dispatched coroutine whose job was cancelled throws when it runs.
import {
	instanceRng,
	levelAndClass,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { traceBuilt, type TraceProgram } from '../../_lib/coroutine-trace.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

// The model of the event loop and of a channel.

const CLOSED = Symbol('closed');
const CANCELLED = Symbol('cancelled');
type Resume = string | number | boolean | typeof CLOSED | typeof CANCELLED | undefined;

type Request =
	| { op: 'send'; ch: Chan; value: string | number }
	| { op: 'trySend'; ch: Chan; value: string | number }
	| { op: 'receive'; ch: Chan }
	| { op: 'close'; ch: Chan }
	| { op: 'cancel'; ch: Chan }
	| { op: 'yield' }
	| { op: 'launch'; body: () => Body; owns?: Chan };

type Body = Generator<Request, void, Resume>;

interface Co {
	body: Body;
	cancelled: boolean;
}

/** A channel: `capacity` 0 is a rendezvous, `Infinity` — UNLIMITED; `conflated` keeps only the newest element. */
interface Chan {
	capacity: number;
	conflated: boolean;
	buffer: (string | number)[];
	receivers: Co[];
	senders: { co: Co; value: string | number }[];
	closed: boolean;
	/** The producer of a `produce` channel: cancelling the channel cancels it. */
	producer: Co | null;
}

const chan = (capacity: number, conflated = false): Chan => ({
	capacity,
	conflated,
	buffer: [],
	receivers: [],
	senders: [],
	closed: false,
	producer: null
});

/** Wrong beliefs about channels, each a switch of one rule of the model. */
interface Beliefs {
	/** `send` never suspends: every channel buffers without limit. */
	unbounded?: boolean;
	/** A channel holds one element more than its capacity (a rendezvous holds one). */
	oneMore?: boolean;
	/** `send` to a waiting receiver switches to it at once; the sender goes to the tail of the queue. */
	switchOnSend?: boolean;
	/** CONFLATED keeps every element, like UNLIMITED. */
	conflatedKeepsAll?: boolean;
	/** `trySend` always succeeds. */
	trySendAlways?: boolean;
	/** `close` drops the buffered elements. */
	closeDrops?: boolean;
	/** Cancelling a `produce` channel leaves its producer running to the end. */
	cancelKeepsProducer?: boolean;
}

/** Runs `main` on the model; returns the printed lines. `print` is the sink the bodies print to. */
function simulate(main: (print: (line: string) => void) => Body, beliefs: Beliefs): string[] {
	const out: string[] = [];
	const print = (line: string): void => {
		out.push(line);
	};
	const queue: { co: Co; value: Resume }[] = [{ co: { body: main(print), cancelled: false }, value: undefined }];
	const room = (ch: Chan): number => {
		if (beliefs.unbounded || (ch.conflated && beliefs.conflatedKeepsAll)) return Infinity;
		return ch.capacity + (beliefs.oneMore && !ch.conflated && ch.capacity !== Infinity ? 1 : 0);
	};
	let steps = 0;
	const run = (co: Co, first: Resume): void => {
		let value: Resume = co.cancelled && first !== CLOSED ? CANCELLED : first;
		for (;;) {
			if ((steps += 1) > 10_000) throw new Error('channels model: the program does not end');
			const next = co.body.next(value);
			if (next.done) return;
			const req = next.value;
			value = undefined;
			if (req.op === 'launch') {
				const child: Co = { body: req.body(), cancelled: false };
				if (req.owns) req.owns.producer = child;
				queue.push({ co: child, value: undefined });
			} else if (req.op === 'yield') {
				queue.push({ co, value: undefined });
				return;
			} else if (req.op === 'send' || req.op === 'trySend') {
				const ch = req.ch;
				const tryOnly = req.op === 'trySend';
				if (ch.closed) {
					value = tryOnly ? false : CLOSED;
				} else if (ch.receivers.length > 0) {
					const receiver = ch.receivers.shift() as Co;
					if (beliefs.switchOnSend && !tryOnly) {
						queue.unshift({ co: receiver, value: req.value });
						queue.push({ co, value: undefined });
						return;
					}
					queue.push({ co: receiver, value: req.value });
					value = tryOnly ? true : undefined;
				} else if (ch.conflated && !beliefs.conflatedKeepsAll && !beliefs.unbounded) {
					ch.buffer = [req.value];
					value = tryOnly ? true : undefined;
				} else if (ch.buffer.length < room(ch)) {
					ch.buffer.push(req.value);
					value = tryOnly ? true : undefined;
				} else if (tryOnly) {
					value = !!beliefs.trySendAlways;
					if (beliefs.trySendAlways) ch.buffer.push(req.value);
				} else {
					ch.senders.push({ co, value: req.value });
					return;
				}
			} else if (req.op === 'receive') {
				const ch = req.ch;
				if (ch.buffer.length > 0) {
					value = ch.buffer.shift();
					const sender = ch.senders.shift();
					if (sender) {
						ch.buffer.push(sender.value);
						queue.push({ co: sender.co, value: undefined });
					}
				} else if (ch.senders.length > 0) {
					const sender = ch.senders.shift() as { co: Co; value: string | number };
					value = sender.value;
					queue.push({ co: sender.co, value: undefined });
				} else if (ch.closed) {
					value = CLOSED;
				} else {
					ch.receivers.push(co);
					return;
				}
			} else if (req.op === 'close') {
				const ch = req.ch;
				ch.closed = true;
				if (beliefs.closeDrops) ch.buffer = [];
				for (const receiver of ch.receivers) queue.push({ co: receiver, value: CLOSED });
				ch.receivers = [];
			} else {
				// Cancelling a `produce` channel: the channel is closed and emptied, its producer is cancelled.
				const ch = req.ch;
				ch.closed = true;
				ch.buffer = [];
				const producer = ch.producer;
				if (producer && !beliefs.cancelKeepsProducer) {
					producer.cancelled = true;
					const waiting = ch.senders.findIndex((s) => s.co === producer);
					if (waiting >= 0) {
						ch.senders.splice(waiting, 1);
						queue.push({ co: producer, value: CANCELLED });
					}
				}
				for (const receiver of ch.receivers) queue.push({ co: receiver, value: CLOSED });
				ch.receivers = [];
				if (beliefs.cancelKeepsProducer) {
					// The producer is believed to go on: its sends land nowhere and never suspend.
					for (const s of ch.senders) queue.push({ co: s.co, value: undefined });
					ch.senders = [];
					ch.capacity = Infinity;
					ch.closed = false;
					ch.buffer = [];
				}
			}
		}
	};
	while (queue.length > 0) {
		const task = queue.shift() as { co: Co; value: Resume };
		run(task.co, task.value);
	}
	return out;
}

/** `for (x in ch) { ... }` as a model loop: yields receive requests until the channel ends. */
function* receiveAll(ch: Chan, each: (x: string | number) => Iterable<Request>): Body {
	for (;;) {
		const x = yield { op: 'receive', ch };
		if (x === CLOSED || x === CANCELLED || x === undefined || typeof x === 'boolean') return;
		yield* each(x);
	}
}

// A: rendezvous or buffered channel between a producer and a consumer.

const capacityExpr = (capacity: number, type: string): string =>
	capacity === 0 ? `Channel<${type}>()` : `Channel<${type}>(${capacity})`;

function capacityClass(rng: Rng): TraceProgram {
	const capacity = rng.pick([0, 0, 1, 2]);
	const items = rng.sample([3, 5, 7, 11, 12, 15, 21, 42, 64, 77], rng.int(3, 4));
	const sentLine = rng.bool(0.5);
	const consumerYields = rng.bool(0.4);
	const consumerLaunched = rng.bool(0.5);
	const ch = rng.pick(['orders', 'jobs', 'events']);
	const v = rng.pick(['id', 'n', 'x']);
	const producer = [
		'launch {',
		`    for (${v} in listOf(${items.join(', ')})) {`,
		`        println("send $${v}")`,
		`        ${ch}.send(${v})`,
		...(sentLine ? [`        println("sent $${v}")`] : []),
		'    }',
		`    ${ch}.close()`,
		'    println("producer done")',
		'}'
	];
	const consumer = [
		`for (${v} in ${ch}) {`,
		`    println("got $${v}")`,
		...(consumerYields ? ['    yield()'] : []),
		'}'
	];
	const lines = [
		'import kotlinx.coroutines.*',
		'import kotlinx.coroutines.channels.*',
		'',
		'fun main() = runBlocking<Unit> {',
		`    val ${ch} = ${capacityExpr(capacity, 'Int')}`,
		...producer.map((l) => `    ${l}`),
		...(consumerLaunched
			? [
					...['launch {', ...consumer.map((l) => `    ${l}`), '    println("consumer done")', '}'].map(
						(l) => `    ${l}`
					)
				]
			: [...consumer.map((l) => `    ${l}`), '    println("consumer done")']),
		'}'
	];
	const run = (beliefs: Beliefs): string[] =>
		simulate((print) => {
			const c = chan(capacity);
			function* produce(): Body {
				for (const x of items) {
					print(`send ${x}`);
					yield { op: 'send', ch: c, value: x };
					if (sentLine) print(`sent ${x}`);
				}
				yield { op: 'close', ch: c };
				print('producer done');
			}
			function* consume(): Body {
				yield* receiveAll(c, function* (x) {
					print(`got ${x}`);
					if (consumerYields) yield { op: 'yield' };
				});
				print('consumer done');
			}
			return (function* (): Body {
				yield { op: 'launch', body: produce };
				if (consumerLaunched) yield { op: 'launch', body: consume };
				else yield* consume();
			})();
		}, beliefs);
	return {
		lines,
		answer: run({}),
		wrong: {
			'send-never-suspends': run({ unbounded: true }),
			'capacity-off-by-one': run({ oneMore: true }),
			'switch-on-send': run({ switchOnSend: true })
		}
	};
}

// B: CONFLATED, UNLIMITED or a small buffer under `trySend`.

const UPDATES = ['loading', 'cached', 'fresh', 'synced', 'stale', 'error', 'retry', 'ready', 'empty', 'paged'];

function trySendClass(rng: Rng): TraceProgram {
	const kind = rng.pick(['CONFLATED', 'UNLIMITED', '1', 'RENDEZVOUS'] as const);
	const capacity = kind === 'UNLIMITED' ? Infinity : kind === '1' || kind === 'CONFLATED' ? 1 : 0;
	const waitingFirst = rng.bool(0.6);
	const words = rng.sample(UPDATES, rng.int(3, 4));
	const consumerYields = rng.bool(0.5);
	const ch = rng.pick(['updates', 'states', 'ticks']);
	const label = rng.pick(['ui', 'screen', 'view']);
	const decl =
		kind === 'RENDEZVOUS'
			? `Channel<String>()`
			: kind === '1'
				? `Channel<String>(1)`
				: `Channel<String>(Channel.${kind})`;
	const lines = [
		'import kotlinx.coroutines.*',
		'import kotlinx.coroutines.channels.*',
		'',
		'fun main() = runBlocking<Unit> {',
		`    val ${ch} = ${decl}`,
		`    launch {`,
		`        for (u in ${ch}) {`,
		`            println("${label}: $u")`,
		...(consumerYields ? ['            yield()'] : []),
		'        }',
		'    }',
		...(waitingFirst ? ['    yield()'] : []),
		...words.map((w) => `    println("${w}: \${${ch}.trySend("${w}").isSuccess}")`),
		`    ${ch}.close()`,
		'}'
	];
	const run = (beliefs: Beliefs): string[] =>
		simulate((print) => {
			const c = chan(capacity, kind === 'CONFLATED');
			function* consume(): Body {
				yield* receiveAll(c, function* (x) {
					print(`${label}: ${x}`);
					if (consumerYields) yield { op: 'yield' };
				});
			}
			return (function* (): Body {
				yield { op: 'launch', body: consume };
				if (waitingFirst) yield { op: 'yield' };
				for (const w of words) {
					const ok = yield { op: 'trySend', ch: c, value: w };
					print(`${w}: ${ok === true}`);
				}
				yield { op: 'close', ch: c };
			})();
		}, beliefs);
	return {
		lines,
		answer: run({}),
		wrong: {
			'conflated-keeps-all': kind === 'CONFLATED' ? run({ conflatedKeepsAll: true }) : null,
			'try-send-always': run({ trySendAlways: true }),
			'capacity-off-by-one': kind === '1' || kind === 'RENDEZVOUS' ? run({ oneMore: true }) : null
		}
	};
}

// Anchor: produce, close and the end of the iteration, or cancelling the channel.

function produceClass(rng: Rng): TraceProgram {
	const capacity = rng.pick([0, 1, 2, 3]);
	const count = rng.int(3, 5);
	const cancel = rng.bool(0.5);
	const take = rng.int(1, count - 1);
	const ch = rng.pick(['pages', 'chunks', 'rows']);
	const word = rng.pick(['page', 'chunk', 'row']);
	const lines = [
		'import kotlinx.coroutines.*',
		'import kotlinx.coroutines.channels.*',
		'',
		'fun main() = runBlocking<Unit> {',
		`    val ${ch} = produce${capacity === 0 ? '' : `(capacity = ${capacity})`} {`,
		'        try {',
		`            for (p in 1..${count}) {`,
		`                send("${word} $p")`,
		'                println("produced $p")',
		'            }',
		'        } finally {',
		'            println("producer stopped")',
		'        }',
		'    }',
		...(cancel
			? [`    repeat(${take}) { println("got \${${ch}.receive()}") }`, `    ${ch}.cancel()`, '    println("cancelled")']
			: [`    for (p in ${ch}) println("got $p")`, '    println("all received")']),
		'}'
	];
	const run = (beliefs: Beliefs): string[] =>
		simulate((print) => {
			const c = chan(capacity);
			function* produce(): Body {
				for (let p = 1; p <= count; p += 1) {
					const r = yield { op: 'send', ch: c, value: `${word} ${p}` };
					if (r === CANCELLED || r === CLOSED) {
						print('producer stopped');
						return;
					}
					print(`produced ${p}`);
				}
				print('producer stopped');
				yield { op: 'close', ch: c };
			}
			return (function* (): Body {
				yield { op: 'launch', body: produce, owns: c };
				if (cancel) {
					for (let i = 0; i < take; i += 1) {
						const x = yield { op: 'receive', ch: c };
						print(`got ${String(x)}`);
					}
					yield { op: 'cancel', ch: c };
					print('cancelled');
				} else {
					yield* receiveAll(c, (x) => {
						print(`got ${x}`);
						return [];
					});
					print('all received');
				}
			})();
		}, beliefs);
	return {
		lines,
		answer: run({}),
		wrong: {
			'close-drops-buffer': cancel ? null : run({ closeDrops: true }),
			'cancel-keeps-producer': cancel ? run({ cancelKeepsProducer: true }) : null,
			'send-never-suspends': run({ unbounded: true })
		}
	};
}

// X: two consumers of one channel.

function fanOutClass(rng: Rng): TraceProgram {
	const capacity = rng.pick([0, 0, 1, 2]);
	const count = rng.int(4, 5);
	const yields = rng.bool(0.5);
	const queued = rng.bool(0.5);
	const ch = rng.pick(['tasks', 'downloads', 'uploads']);
	const worker = rng.pick(['worker', 'w', 'thread']);
	const items = rng.sample([2, 4, 6, 8, 10, 12, 14, 16, 18, 20], count);
	const lines = [
		'import kotlinx.coroutines.*',
		'import kotlinx.coroutines.channels.*',
		'',
		'fun main() = runBlocking<Unit> {',
		`    val ${ch} = ${capacityExpr(capacity, 'Int')}`,
		'    repeat(2) { id ->',
		'        launch {',
		`            for (t in ${ch}) {`,
		`                println("${worker} $id: $t")`,
		...(yields ? ['                yield()'] : []),
		'            }',
		'        }',
		'    }',
		`    for (t in listOf(${items.join(', ')})) {`,
		`        ${ch}.send(t)`,
		...(queued ? ['        println("queued $t")'] : []),
		'    }',
		`    ${ch}.close()`,
		'}'
	];
	const run = (beliefs: Beliefs): string[] =>
		simulate((print) => {
			const c = chan(capacity);
			const consumer = (id: number) =>
				function* (): Body {
					yield* receiveAll(c, function* (x) {
						print(`${worker} ${id}: ${x}`);
						if (yields) yield { op: 'yield' };
					});
				};
			return (function* (): Body {
				yield { op: 'launch', body: consumer(0) };
				yield { op: 'launch', body: consumer(1) };
				for (const t of items) {
					yield { op: 'send', ch: c, value: t };
					if (queued) print(`queued ${t}`);
				}
				yield { op: 'close', ch: c };
			})();
		}, beliefs);
	const truth = run({});
	const roundRobin = (): string[] => {
		// The belief that the two workers strictly alternate, the sends interleaved as in the true run.
		let k = 0;
		return truth.map((line) =>
			line.startsWith(`${worker} `) ? line.replace(/^(\S+) \d:/, () => `${worker} ${k++ % 2}:`) : line
		);
	};
	return {
		lines,
		answer: truth,
		wrong: {
			'round-robin': roundRobin(),
			'send-never-suspends': run({ unbounded: true }),
			'switch-on-send': run({ switchOnSend: true })
		}
	};
}

const CLASSES: Readonly<Record<string, (rng: Rng) => TraceProgram>> = {
	capacity: capacityClass,
	'try-send': trySendClass,
	produce: produceClass,
	'fan-out': fanOutClass
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const make = CLASSES[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no program for class ${input.classId}`);
	return traceBuilt(descriptor, input, make(instanceRng(descriptor, input)));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
