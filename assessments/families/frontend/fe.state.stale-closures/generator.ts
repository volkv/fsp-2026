// Stale closures: a minimal hooks runtime (useState, useEffect with dependencies, useMemo, useCallback, useRef, fake
// timers and a message bus) shown in full, and a component with exactly one defective line — a stale closure in an
// interval or a handler, incomplete dependencies, a value update instead of a functional one, a missing or wrong
// cleanup. The checks render the component through a scenario and print `ok` when the specification holds; the gate
// proves the defect line by running the program with Node: it fails, with the line fixed it passes, and the lines
// the misconceptions blame do not repair it.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeDefectProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const RUNTIME = `// A minimal hooks runtime: one mounted component, re-rendered synchronously after a state change.
const slots = [];
let cursor = 0;
let root = null;
let queue = [];
let rendering = false;
let dirty = false;

function depsChanged(prev, next) {
  if (prev === undefined || next === undefined) return true;
  return prev.length !== next.length || prev.some((dep, i) => !Object.is(dep, next[i]));
}

function useState(initial) {
  const i = cursor++;
  if (slots[i] === undefined) {
    const slot = { value: initial };
    slot.set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      if (rendering) dirty = true;
      else rerender();
    };
    slots[i] = slot;
  }
  return [slots[i].value, slots[i].set];
}

function useMemo(compute, deps) {
  const i = cursor++;
  const slot = slots[i];
  if (slot !== undefined && !depsChanged(slot.deps, deps)) return slot.value;
  slots[i] = { value: compute(), deps };
  return slots[i].value;
}

function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

function useRef(initial) {
  return useMemo(() => ({ current: initial }), []);
}

function useEffect(effect, deps) {
  const i = cursor++;
  const slot = slots[i];
  if (slot !== undefined && !depsChanged(slot.deps, deps)) return;
  const next = { deps, cleanup: undefined };
  slots[i] = next;
  queue.push({ prev: slot, next, effect });
}

function rerender() {
  rendering = true;
  do {
    dirty = false;
    cursor = 0;
    root.output = root.component(root.props);
    const effects = queue;
    queue = [];
    // As in React: every cleanup of a commit runs before any effect body of it.
    for (const job of effects) {
      if (job.prev !== undefined && typeof job.prev.cleanup === 'function') job.prev.cleanup();
    }
    for (const job of effects) job.next.cleanup = job.effect();
  } while (dirty);
  rendering = false;
}

function mount(component, props) {
  root = { component, props, output: null };
  rerender();
}

function update(props) {
  root.props = props;
  rerender();
}

function unmount() {
  for (const slot of slots) {
    if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup();
  }
}

// Fake timers: time moves only with advance(ms).
let now = 0;
let timers = [];
let timerId = 0;

function setInterval(fn, ms) {
  timers.push({ id: ++timerId, fn, ms, at: now + ms });
  return timerId;
}

function clearInterval(id) {
  timers = timers.filter((t) => t.id !== id);
}

function later(ms, fn) {
  const id = setInterval(() => {
    clearInterval(id);
    fn();
  }, ms);
  return () => clearInterval(id);
}

function advance(ms) {
  const end = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (due === undefined) break;
    now = due.at;
    due.at += due.ms;
    due.fn();
  }
  now = end;
}

// A message bus: subscribe returns the function that unsubscribes.
const listeners = new Map();
let subscriptions = 0;

function subscribe(topic, fn) {
  subscriptions++;
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

function publish(topic, message) {
  for (const fn of [...(listeners.get(topic) ?? [])]) fn(message);
}`;

const RUNTIME_LINES = RUNTIME.split('\n');
const COMPARE_LINE = RUNTIME_LINES.findIndex((l) => l.includes('!Object.is(dep, next[i])'));
const COMPARE_WRONG = '  return prev.length !== next.length || prev.some((dep, i) => dep !== next[i]);';

type WrongId = 'deps-array' | 'hook-body' | 'cleanup-line' | 'state-setter' | 'neighbour-line' | 'ref-sync';

/** A component with its defect: indexes are 0-based within `lines`. */
interface Component {
	/** Helpers the component needs, placed among the module's other helpers. */
	helpers: string[][];
	lines: string[];
	defect: number;
	fix: string;
	distractors: { index: number; replacement: string; wrong: WrongId }[];
	/** The specification, in the statement. */
	spec: string;
	/** JavaScript statements of the checks; they end by printing `ok` or `fail …`. */
	check: string[];
}

/** Lines of a component with named marks on the lines a defect or a distractor needs. */
class Lines {
	readonly lines: string[] = [];
	readonly #marks = new Map<string, number>();

	add(...lines: string[]): this {
		this.lines.push(...lines);
		return this;
	}

	mark(name: string, line: string): this {
		this.#marks.set(name, this.lines.length);
		this.lines.push(line);
		return this;
	}

	at(name: string): number {
		const index = this.#marks.get(name);
		if (index === undefined) throw new Error(`no mark ${name}`);
		return index;
	}
}

const verdict = (condition: string, detail: string): string => `console.log(${condition} ? 'ok' : \`fail ${detail}\`);`;

const COMPONENT_NAMES = {
	ticker: ['Ticker', 'Stopwatch', 'Heartbeat', 'Counter'],
	progress: ['Upload', 'Progress', 'Installer', 'Sync'],
	list: ['PriceList', 'Catalog', 'Offers', 'Products'],
	search: ['Directory', 'People', 'Contacts', 'Members'],
	cart: ['Cart', 'Basket', 'Order', 'Checkout'],
	wallet: ['Wallet', 'Budget', 'Ledger', 'Balance'],
	chat: ['ChatRoom', 'Inbox', 'Channel', 'Thread'],
	poller: ['Poller', 'Monitor', 'Watcher', 'Probe'],
	pager: ['Results', 'Feed', 'Table', 'Listing'],
	notifier: ['Notifier', 'Alerts', 'Toasts', 'Banner'],
	tabs: ['Tabs', 'Sections', 'Panels', 'Views'],
	lookup: ['Lookup', 'Finder', 'Suggest', 'Autocomplete']
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Middle.

function intervalStale(rng: Rng): Component {
	const period = rng.pick([200, 250, 500, 1000]);
	const ticks = rng.int(3, 5);
	const elapsed = period * ticks + period / 2;
	if (rng.bool()) {
		const name = rng.pick(COMPONENT_NAMES.ticker);
		const step = rng.int(2, 7);
		const label = rng.pick(['count', 'beats', 'ticks', 'total']);
		const l = new Lines()
			.add(`function ${name}({ step }) {`, '  const [count, setCount] = useState(0);', '  useEffect(() => {')
			.add('    const id = setInterval(() => {')
			.mark('defect', '      setCount(count + step);')
			.add(`    }, ${period});`)
			.mark('cleanup', '    return () => clearInterval(id);')
			.mark('deps', '  }, []);')
			.add(`  return { text: \`${label}: \${count}\` };`, '}');
		return {
			helpers: [],
			lines: l.lines,
			defect: l.at('defect'),
			fix: '      setCount((c) => c + step);',
			distractors: [
				{ index: l.at('deps'), replacement: '  }, [step]);', wrong: 'deps-array' },
				{ index: l.at('cleanup'), replacement: '    return () => void clearInterval(id);', wrong: 'cleanup-line' }
			],
			spec:
				`Компонент \`${name}\` каждые ${period} мс увеличивает счётчик на \`step\` (проп \`step\` за время жизни ` +
				'компонента не меняется). Интервал создаётся один раз за время жизни компонента и очищается при размонтировании.',
			check: [
				`mount(${name}, { step: ${step} });`,
				`advance(${elapsed});`,
				'const text = root.output.text;',
				'const created = timerId;',
				'unmount();',
				verdict(
					`text === '${label}: ${step * ticks}' && created === 1 && timers.length === 0`,
					'${text} ${created} ${timers.length}'
				)
			]
		};
	}
	const name = rng.pick(COMPONENT_NAMES.progress);
	const chunk = rng.int(3, 9);
	const l = new Lines()
		.add(`function ${name}({ chunk }) {`, '  const [progress, setProgress] = useState(0);', '  useEffect(() => {')
		.add('    const id = setInterval(() => {')
		.mark('defect', '      setProgress(Math.min(progress + chunk, 100));')
		.add(`    }, ${period});`)
		.mark('cleanup', '    return () => clearInterval(id);')
		.mark('deps', '  }, []);')
		.add('  return { text: `${progress}%`, done: progress === 100 };', '}');
	return {
		helpers: [],
		lines: l.lines,
		defect: l.at('defect'),
		fix: '      setProgress((p) => Math.min(p + chunk, 100));',
		distractors: [
			{ index: l.at('deps'), replacement: '  }, [chunk]);', wrong: 'deps-array' },
			{ index: l.at('cleanup'), replacement: '    return () => void clearInterval(id);', wrong: 'cleanup-line' }
		],
		spec:
			`Компонент \`${name}\` каждые ${period} мс прибавляет к прогрессу \`chunk\` процентов, но не больше 100 ` +
			'(проп `chunk` за время жизни компонента не меняется). Интервал создаётся один раз за время жизни компонента и ' +
			'очищается при размонтировании.',
		check: [
			`mount(${name}, { chunk: ${chunk} });`,
			`advance(${elapsed});`,
			'const text = root.output.text;',
			'const created = timerId;',
			'unmount();',
			verdict(
				`text === '${chunk * ticks}%' && created === 1 && timers.length === 0`,
				'${text} ${created} ${timers.length}'
			)
		]
	};
}

function memoDeps(rng: Rng): Component {
	const stats = rng.pick(['stats', 'metrics', 'counters']);
	const statsLine = [`const ${stats} = { runs: 0 };`];
	if (rng.bool()) {
		const name = rng.pick(COMPONENT_NAMES.list);
		const prices = rng.sample([5, 8, 12, 15, 19, 23, 27, 31, 36, 42], 6);
		const names = rng.sample(['tea', 'jam', 'map', 'pen', 'cup', 'box', 'hat', 'kit'], 6);
		const items = names.map((n, i) => ({ name: n, price: prices[i] ?? 0 }));
		const sortedPrices = [...prices].sort((a, b) => a - b);
		const first = sortedPrices[4] ?? 0;
		const second = sortedPrices[1] ?? 0;
		const expect = (max: number, reversed: boolean): string => {
			const list = items.filter((x) => x.price <= max).map((x) => x.name);
			return (reversed ? list.reverse() : list).join(',');
		};
		const l = new Lines()
			.add(`function ${name}({ items, max }) {`, "  const [order, setOrder] = useState('asc');")
			.add('  const visible = useMemo(() => {', `    ${stats}.runs++;`)
			.mark('body', '    return items.filter((item) => item.price <= max);')
			.mark('defect', '  }, [items]);')
			.mark('setter', "  const toggle = useCallback(() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc')), []);")
			.add("  const sorted = order === 'asc' ? visible : [...visible].reverse();")
			.add('  return { names: sorted.map((item) => item.name).join(), toggle };', '}');
		return {
			helpers: [statsLine],
			lines: l.lines,
			defect: l.at('defect'),
			fix: '  }, [items, max]);',
			distractors: [
				{
					index: l.at('body'),
					replacement: '    return items.filter((item) => item.price < max + 1);',
					wrong: 'hook-body'
				},
				{
					index: l.at('setter'),
					replacement: "  const toggle = () => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));",
					wrong: 'state-setter'
				}
			],
			spec:
				`Компонент \`${name}\` показывает товары с ценой не выше \`max\` в выбранном порядке. Фильтр ` +
				'пересчитывается только при изменении `items` или `max` — повторный рендер с теми же пропами и смена ' +
				'порядка его не пересчитывают.',
			check: [
				`const items = ${JSON.stringify(items)};`,
				`mount(${name}, { items, max: ${first} });`,
				'const first = root.output.names;',
				'root.output.toggle();',
				`update({ items, max: ${second} });`,
				'const second = root.output.names;',
				`update({ items, max: ${second} });`,
				verdict(
					`first === '${expect(first, false)}' && second === '${expect(second, true)}' && ${stats}.runs === 2`,
					`\${first} \${second} \${${stats}.runs}`
				)
			]
		};
	}
	const name = rng.pick(COMPONENT_NAMES.search);
	const people = rng.sample(['anna', 'boris', 'vera', 'gleb', 'dina', 'egor', 'zoya', 'ilya', 'kira', 'lev'], 6);
	const letters = [...new Set(people.join(''))];
	// Two queries that select different, non-empty lists.
	let q1 = 'a';
	let q2 = 'e';
	for (let tries = 0; tries < 50; tries += 1) {
		const [x, y] = rng.sample(letters, 2) as [string, string];
		const a = people.filter((p) => p.includes(x)).join();
		const b = people.filter((p) => p.includes(y)).join();
		if (a !== '' && b !== '' && a !== b) {
			q1 = x;
			q2 = y;
			break;
		}
	}
	const found = (q: string): string => people.filter((p) => p.includes(q)).join();
	const pickName = people[0] ?? 'anna';
	const l = new Lines()
		.add(`function ${name}({ people, query }) {`, '  const [selected, setSelected] = useState(null);')
		.add('  const found = useMemo(() => {', `    ${stats}.runs++;`)
		.mark('body', '    return people.filter((person) => person.includes(query));')
		.mark('defect', '  }, [people]);')
		.mark('setter', '  const select = useCallback((person) => setSelected(person), []);')
		.add('  return { list: found.join(), selected, select };', '}');
	return {
		helpers: [statsLine],
		lines: l.lines,
		defect: l.at('defect'),
		fix: '  }, [people, query]);',
		distractors: [
			{
				index: l.at('body'),
				replacement: '    return people.filter((person) => person.indexOf(query) !== -1);',
				wrong: 'hook-body'
			},
			{ index: l.at('setter'), replacement: '  const select = (person) => setSelected(person);', wrong: 'state-setter' }
		],
		spec:
			`Компонент \`${name}\` показывает людей, в имени которых есть подстрока \`query\`, и помнит выбранного. ` +
			'Поиск пересчитывается только при изменении `people` или `query` — выбор человека и повторный рендер с теми же ' +
			'пропами его не пересчитывают.',
		check: [
			`const people = ${JSON.stringify(people)};`,
			`mount(${name}, { people, query: '${q1}' });`,
			'const first = root.output.list;',
			`root.output.select('${pickName}');`,
			`update({ people, query: '${q2}' });`,
			'const second = root.output.list;',
			`update({ people, query: '${q2}' });`,
			verdict(
				`first === '${found(q1)}' && second === '${found(q2)}' && root.output.selected === '${pickName}' && ${stats}.runs === 2`,
				`\${first} \${second} \${${stats}.runs}`
			)
		]
	};
}

function functionalUpdate(rng: Rng): Component {
	if (rng.bool()) {
		const name = rng.pick(COMPONENT_NAMES.cart);
		const price = rng.int(3, 40);
		const [n1, n2] = [rng.int(2, 4), rng.int(2, 5)];
		const l = new Lines()
			.add(`function ${name}({ price }) {`, '  const [total, setTotal] = useState(0);')
			.add('  const [entries, setEntries] = useState([]);', '  const addMany = (qty) => {')
			.mark('loop', '    for (let i = 0; i < qty; i++) {')
			.mark('defect', '      setTotal(total + price);')
			.add('    }')
			.mark('setter', '    setEntries((list) => [...list, qty]);')
			.add('  };', '  return { total, lines: entries.length, addMany };', '}');
		return {
			helpers: [],
			lines: l.lines,
			defect: l.at('defect'),
			fix: '      setTotal((t) => t + price);',
			distractors: [
				{ index: l.at('loop'), replacement: '    for (let i = 1; i <= qty; i++) {', wrong: 'neighbour-line' },
				{ index: l.at('setter'), replacement: '    setEntries([...entries, qty]);', wrong: 'state-setter' }
			],
			spec:
				`Компонент \`${name}\`: \`addMany(qty)\` добавляет в корзину \`qty\` единиц товара по цене \`price\` — сумма ` +
				'растёт на `qty · price`, а число строк заказа — на одну.',
			check: [
				`mount(${name}, { price: ${price} });`,
				`root.output.addMany(${n1});`,
				`root.output.addMany(${n2});`,
				verdict(
					`root.output.total === ${price * (n1 + n2)} && root.output.lines === 2`,
					'${root.output.total} ${root.output.lines}'
				)
			]
		};
	}
	const name = rng.pick(COMPONENT_NAMES.wallet);
	const start = rng.int(50, 200);
	const deltas = Array.from({ length: rng.int(3, 4) }, () => rng.pick([-1, 1]) * rng.int(5, 40));
	const more = [rng.int(5, 40), -rng.int(5, 40)] as [number, number];
	// With the defect only the last delta of a batch lands; keep that from matching the specification by chance.
	if (deltas.slice(0, -1).reduce((a, b) => a + b, 0) + more[0] === 0) more[0] += 1;
	const l = new Lines()
		.add(`function ${name}({ start }) {`, '  const [balance, setBalance] = useState(start);')
		.add('  const [batches, setBatches] = useState(0);', '  const applyAll = (deltas) => {')
		.mark('loop', '    for (const delta of deltas) {')
		.mark('defect', '      setBalance(balance + delta);')
		.add('    }')
		.mark('setter', '    setBatches((n) => n + 1);')
		.add('  };', '  return { balance, batches, applyAll };', '}');
	const sum = [...deltas, ...more].reduce((a, b) => a + b, start);
	return {
		helpers: [],
		lines: l.lines,
		defect: l.at('defect'),
		fix: '      setBalance((b) => b + delta);',
		distractors: [
			{ index: l.at('loop'), replacement: '    for (const delta of [...deltas]) {', wrong: 'neighbour-line' },
			{ index: l.at('setter'), replacement: '    setBatches(batches + 1);', wrong: 'state-setter' }
		],
		spec:
			`Компонент \`${name}\`: \`applyAll(deltas)\` применяет к балансу все изменения из списка по порядку и ` +
			'увеличивает число применённых пакетов на один.',
		check: [
			`mount(${name}, { start: ${start} });`,
			`root.output.applyAll(${JSON.stringify(deltas)});`,
			`root.output.applyAll(${JSON.stringify(more)});`,
			verdict(
				`root.output.balance === ${sum} && root.output.batches === 2`,
				'${root.output.balance} ${root.output.batches}'
			)
		]
	};
}

function missingCleanup(rng: Rng): Component {
	if (rng.bool()) {
		const name = rng.pick(COMPONENT_NAMES.chat);
		const [roomA, roomB] = rng.sample(['general', 'random', 'news', 'support', 'sales', 'dev'], 2) as [string, string];
		const [k1, k2] = [rng.int(2, 3), rng.int(1, 3)];
		const l = new Lines()
			.add(`function ${name}({ room }) {`, '  const [unread, setUnread] = useState(0);', '  useEffect(() => {')
			.mark('setter', '    setUnread(0);')
			.mark('defect', '    subscribe(room, () => setUnread((n) => n + 1));')
			.mark('deps', '  }, [room]);')
			.add('  return { text: `${room}: ${unread}` };', '}');
		const publish = (room: string, count: number): string[] =>
			Array.from({ length: count }, (_, i) => `publish('${room}', 'm${i}');`);
		return {
			helpers: [],
			lines: l.lines,
			defect: l.at('defect'),
			fix: '    return subscribe(room, () => setUnread((n) => n + 1));',
			distractors: [
				{ index: l.at('setter'), replacement: '    setUnread(() => 0);', wrong: 'state-setter' },
				{ index: l.at('deps'), replacement: '  }, [room, unread]);', wrong: 'deps-array' }
			],
			spec:
				`Компонент \`${name}\` считает непрочитанные сообщения текущей комнаты \`room\`: при смене комнаты счётчик ` +
				'обнуляется и считаются только сообщения новой комнаты; после размонтирования компонент ни на что не подписан.',
			check: [
				`mount(${name}, { room: '${roomA}' });`,
				...publish(roomA, k1),
				`update({ room: '${roomB}' });`,
				...publish(roomA, 2),
				...publish(roomB, k2),
				'const text = root.output.text;',
				'unmount();',
				'const left = [...listeners.values()].reduce((n, set) => n + set.size, 0);',
				verdict(`text === '${roomB}: ${k2}' && left === 0`, '${text} ${left}')
			]
		};
	}
	const name = rng.pick(COMPONENT_NAMES.poller);
	const [p1, p2] = rng.sample([200, 300, 400, 500], 2) as [number, number];
	const n2 = rng.int(2, 4);
	const l = new Lines()
		.add(`function ${name}({ period }) {`, '  const [ticks, setTicks] = useState(0);', '  useEffect(() => {')
		.mark('setter', '    setTicks(0);')
		.add('    const id = setInterval(() => setTicks((t) => t + 1), period);')
		.mark('defect', '    return () => clearInterval(period);')
		.mark('deps', '  }, [period]);')
		.add('  return { ticks };', '}');
	return {
		helpers: [],
		lines: l.lines,
		defect: l.at('defect'),
		fix: '    return () => clearInterval(id);',
		distractors: [
			{ index: l.at('setter'), replacement: '    setTicks(() => 0);', wrong: 'state-setter' },
			{ index: l.at('deps'), replacement: '  }, [period, ticks]);', wrong: 'deps-array' }
		],
		spec:
			`Компонент \`${name}\` считает срабатывания интервала с периодом \`period\`: при смене периода счётчик ` +
			'обнуляется и работает только интервал с новым периодом; после размонтирования таймеров не остаётся.',
		check: [
			`mount(${name}, { period: ${p1} });`,
			`advance(${p1 * 2 + 10});`,
			`update({ period: ${p2} });`,
			`advance(${p2 * n2 + 10});`,
			'const ticks = root.output.ticks;',
			'unmount();',
			verdict(`ticks === ${n2} && timers.length === 0`, '${ticks} ${timers.length}')
		]
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Senior.

function callbackDeps(rng: Rng): Component {
	const name = rng.pick(COMPONENT_NAMES.pager);
	const log = rng.pick(['requests', 'calls', 'fetches']);
	const [q1, q2] = rng.sample(['tea', 'jam', 'ink', 'oak', 'sun', 'sky'], 2) as [string, string];
	const size = rng.int(2, 4);
	const nexts = rng.int(1, 2);
	const helper = [
		'function fetchRows(query, page, size) {',
		'  return Array.from({ length: size }, (_, i) => `${query}${(page - 1) * size + i + 1}`);',
		'}'
	];
	const l = new Lines()
		.add(`function ${name}({ query, size }) {`, '  const [page, setPage] = useState(1);')
		.add('  const [rows, setRows] = useState([]);', '  const load = useCallback(() => {')
		.add(`    ${log}.push(\`\${query}:\${page}:\${size}\`);`, '    setRows(fetchRows(query, page, size));')
		.mark('defect', '  }, [query, size]);')
		.add('  useEffect(() => {', '    load();')
		.mark('deps', '  }, [load]);')
		.mark('setter', '  const next = useCallback(() => setPage((p) => p + 1), []);')
		.add('  return { rows: rows.join(), page, next };', '}');
	const expected: string[] = [`${q1}:1:${size}`];
	for (let p = 2; p <= nexts + 1; p += 1) expected.push(`${q1}:${p}:${size}`);
	expected.push(`${q2}:${nexts + 1}:${size}`);
	const lastRows = Array.from({ length: size }, (_, i) => `${q2}${nexts * size + i + 1}`).join();
	return {
		helpers: [helper, [`const ${log} = [];`]],
		lines: l.lines,
		defect: l.at('defect'),
		fix: '  }, [query, page, size]);',
		distractors: [
			{ index: l.at('deps'), replacement: '  }, [load, page]);', wrong: 'deps-array' },
			{ index: l.at('setter'), replacement: '  const next = () => setPage(page + 1);', wrong: 'state-setter' }
		],
		spec:
			`Компонент \`${name}\` показывает страницу \`page\` результатов по запросу \`query\`, по \`size\` строк. ` +
			'Страница загружается ровно один раз при монтировании и при каждом изменении `query`, `size` или номера ' +
			'страницы; каждая загрузка записывается в журнал.',
		check: [
			`mount(${name}, { query: '${q1}', size: ${size} });`,
			...Array.from({ length: nexts }, () => 'root.output.next();'),
			`update({ query: '${q2}', size: ${size} });`,
			`const made = ${log}.join();`,
			verdict(`made === '${expected.join(',')}' && root.output.rows === '${lastRows}'`, '${made} ${root.output.rows}')
		]
	};
}

function latestRef(rng: Rng): Component {
	const name = rng.pick(COMPONENT_NAMES.notifier);
	const channel = rng.pick(['alerts', 'deploys', 'billing', 'builds']);
	const messages = rng.sample(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], 5);
	// Messages arrive in three phases: before muting, while muted, after unmuting.
	const split1 = rng.int(1, 2);
	const split2 = split1 + rng.int(1, 2);
	const l = new Lines()
		.add(`function ${name}({ channel }) {`, '  const [muted, setMuted] = useState(false);')
		.add('  const [shown, setShown] = useState([]);', '  const mutedRef = useRef(muted);')
		.mark('ref', '  mutedRef.current = muted;')
		.add('  useEffect(() => {', '    return subscribe(channel, (message) => {')
		.mark('defect', '      if (!muted) setShown((list) => [...list, message]);')
		.add('    });')
		.mark('deps', '  }, [channel]);')
		.mark('setter', '  const toggle = useCallback(() => setMuted((m) => !m), []);')
		.add('  return { shown: shown.join(), toggle };', '}');
	const phase = (from: number, to: number): string[] =>
		messages.slice(from, to).map((m) => `publish('${channel}', '${m}');`);
	const visible = [...messages.slice(0, split1), ...messages.slice(split2)];
	return {
		helpers: [],
		lines: l.lines,
		defect: l.at('defect'),
		fix: '      if (!mutedRef.current) setShown((list) => [...list, message]);',
		distractors: [
			{ index: l.at('ref'), replacement: '  mutedRef.current = !muted;', wrong: 'ref-sync' },
			{ index: l.at('deps'), replacement: '  }, [channel, muted]);', wrong: 'deps-array' },
			{ index: l.at('setter'), replacement: '  const toggle = () => setMuted(!muted);', wrong: 'state-setter' }
		],
		spec:
			`Компонент \`${name}\` показывает сообщения канала \`channel\`, пока звук не выключен: сообщения, ` +
			'пришедшие при выключенном звуке, не показываются. Подписка на канал создаётся один раз, пока канал тот же, — ' +
			'переключение звука не переподписывает компонент.',
		check: [
			`mount(${name}, { channel: '${channel}' });`,
			...phase(0, split1),
			'root.output.toggle();',
			...phase(split1, split2),
			'root.output.toggle();',
			...phase(split2, messages.length),
			verdict(
				`root.output.shown === '${visible.join(',')}' && subscriptions === 1`,
				'${root.output.shown} ${subscriptions}'
			)
		]
	};
}

function cleanupReadsRef(rng: Rng): Component {
	const name = rng.pick(COMPONENT_NAMES.tabs);
	const log = rng.pick(['visits', 'views', 'timings']);
	const tabs = rng.sample(['home', 'cart', 'help', 'news', 'faq', 'profile'], 3) as [string, string, string];
	const spans = [rng.int(3, 19) * 100, rng.int(3, 19) * 100, rng.int(3, 19) * 100] as const;
	const l = new Lines()
		.add(`function ${name}({ initial }) {`, '  const [tab, setTab] = useState(initial);')
		.add('  const tabRef = useRef(tab);')
		.mark('ref', '  tabRef.current = tab;')
		.add('  useEffect(() => {')
		.mark('body', '    const opened = now;')
		.mark('defect', `    return () => ${log}.push(\`\${tabRef.current}:\${now - opened}\`);`)
		.mark('deps', '  }, [tab]);')
		.add('  const describe = useCallback(() => `on ${tabRef.current}`, []);')
		.add('  return { tab, open: setTab, title: describe() };', '}');
	const expected = tabs.map((t, i) => `${t}:${spans[i] ?? 0}`).join(',');
	return {
		helpers: [[`const ${log} = [];`]],
		lines: l.lines,
		defect: l.at('defect'),
		fix: `    return () => ${log}.push(\`\${tab}:\${now - opened}\`);`,
		distractors: [
			{ index: l.at('ref'), replacement: '  tabRef.current = initial;', wrong: 'ref-sync' },
			{ index: l.at('deps'), replacement: '  }, []);', wrong: 'deps-array' },
			{ index: l.at('body'), replacement: '    const opened = now + 0;', wrong: 'hook-body' }
		],
		spec:
			`Компонент \`${name}\` записывает в журнал, сколько миллисекунд была открыта каждая вкладка: запись ` +
			'`<вкладка>:<время>` появляется, когда вкладку закрывают (открывают другую или размонтируют компонент). ' +
			'Подпись `title` называет вкладку, открытую сейчас: `on <вкладка>`.',
		check: [
			`mount(${name}, { initial: '${tabs[0]}' });`,
			`advance(${spans[0]});`,
			`root.output.open('${tabs[1]}');`,
			`advance(${spans[1]});`,
			`root.output.open('${tabs[2]}');`,
			`advance(${spans[2]});`,
			'const title = root.output.title;',
			'unmount();',
			`const made = ${log}.join();`,
			verdict(`made === '${expected}' && title === 'on ${tabs[2]}'`, '${made} ${title}')
		]
	};
}

function staleAsync(rng: Rng): Component {
	const name = rng.pick(COMPONENT_NAMES.lookup);
	const base = rng.pick([1200, 2400]);
	const word = rng.pick(['kate', 'mars', 'lion', 'rose', 'nord']);
	const steps = rng.int(2, 3);
	const gap = rng.pick([50, 100, 150]);
	const helpers = [
		['function latency(query) {', `  return ${base} / query.length;`, '}'],
		['function lookup(query) {', '  return query.toUpperCase();', '}']
	];
	const l = new Lines()
		.add(`function ${name}({ query }) {`, "  const [results, setResults] = useState('');")
		.add('  const [history, setHistory] = useState([]);', '  useEffect(() => {')
		.mark('setter', '    setHistory((list) => [...list, query]);')
		.mark('defect', '    later(latency(query), () => setResults(lookup(query)));')
		.mark('deps', '  }, [query]);')
		.add('  return { results, searches: history.length };', '}');
	const queries = Array.from({ length: steps + 1 }, (_, i) => word.slice(0, i + 1));
	const final = queries[queries.length - 1] ?? word;
	return {
		helpers,
		lines: l.lines,
		defect: l.at('defect'),
		fix: '    return later(latency(query), () => setResults(lookup(query)));',
		distractors: [
			{ index: l.at('setter'), replacement: '    setHistory([...history, query]);', wrong: 'state-setter' },
			{ index: l.at('deps'), replacement: '  }, []);', wrong: 'deps-array' }
		],
		spec:
			`Компонент \`${name}\` ищет по запросу \`query\`; ответ приходит через \`latency(query)\` мс. После серии ` +
			'запросов на экране — результат последнего запроса; ответы на запросы, которые уже сменились, не показываются. ' +
			'Каждый запрос записывается в историю; после размонтирования таймеров не остаётся.',
		check: [
			`mount(${name}, { query: '${queries[0] ?? word}' });`,
			...queries.slice(1).flatMap((q) => [`advance(${gap});`, `update({ query: '${q}' });`]),
			`advance(${base * 2});`,
			'const results = root.output.results;',
			'const searches = root.output.searches;',
			'unmount();',
			verdict(
				`results === '${final.toUpperCase()}' && searches === ${queries.length} && timers.length === 0`,
				'${results} ${searches} ${timers.length}'
			)
		]
	};
}

const COMPONENTS: Record<string, (rng: Rng) => Component> = {
	'middle/interval-stale': intervalStale,
	'middle/memo-deps': memoDeps,
	'middle/functional-update': functionalUpdate,
	'middle/missing-cleanup': missingCleanup,
	'senior/callback-deps': callbackDeps,
	'senior/latest-ref': latestRef,
	'senior/cleanup-reads-ref': cleanupReadsRef,
	'senior/stale-async': staleAsync
};

/** Module helpers unrelated to the defect: they vary where the component starts. */
const FILLER: string[][] = [
	['function formatPrice(value) {', '  return `${value.toFixed(2)} ₽`;', '}'],
	['function clamp(value, min, max) {', '  return Math.min(Math.max(value, min), max);', '}'],
	[
		'function pluralize(count, one, many) {',
		'  if (count === 1) return `${count} ${one}`;',
		'  return `${count} ${many}`;',
		'}'
	],
	['function Badge({ count }) {', "  if (count === 0) return { text: '' };", '  return { text: String(count) };', '}'],
	['function initials(name) {', '  return name.slice(0, 1).toUpperCase();', '}'],
	[
		'function percent(part, whole) {',
		'  if (whole === 0) return 0;',
		'  return Math.round((part / whole) * 100);',
		'}'
	],
	['function isEmpty(list) {', '  return list.length === 0;', '}'],
	['function Spinner({ visible }) {', "  return { text: visible ? '...' : '' };", '}'],
	[
		'function shortDate(ms) {',
		'  const date = new Date(ms);',
		'  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}`;',
		'}'
	],
	["const API_URL = '/api/v2';"],
	['const PAGE_LIMIT = 50;'],
	["const THEME = 'light';"],
	["const LOCALE = 'ru-RU';"],
	['const RETRY_LIMIT = 3;'],
	['const DEBOUNCE_MS = 300;']
];

interface Program {
	source: string;
	answer: number;
	fix: string;
	check: string;
	distractors: { line: number; replacement: string; wrong: WrongId | 'runtime-compare' }[];
	spec: string;
}

function compose(rng: Rng, component: Component): Program {
	const filler = rng.sample(FILLER, rng.int(0, FILLER.length));
	const blocks = rng.shuffle([...filler, ...component.helpers]);
	const lines = [...RUNTIME_LINES, ''];
	for (const block of blocks) lines.push('', ...block);
	lines.push('', '');
	const offset = lines.length;
	lines.push(...component.lines);
	return {
		source: lines.join('\n'),
		answer: offset + component.defect + 1,
		fix: component.fix,
		check: component.check.join('\n'),
		distractors: [
			...component.distractors.map((d) => ({ line: offset + d.index + 1, replacement: d.replacement, wrong: d.wrong })),
			{ line: COMPARE_LINE + 1, replacement: COMPARE_WRONG, wrong: 'runtime-compare' as const }
		],
		spec: component.spec
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = COMPONENTS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no component for ${input.grade}/${input.classId}`);
	const p = compose(rng, make(rng));
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown: [
				'Ниже — минимальная модель хуков (как в React: состояние, эффекты с зависимостями, мемоизация, ref), ' +
					'поддельные таймеры, шина сообщений и компонент. Время в программе идёт только при вызове `advance`.',
				'',
				`**Спецификация.** ${p.spec}`,
				'',
				'Ровно одна строка программы нарушает спецификацию: если заменить только её, компонент будет работать по ' +
					'спецификации. Введите номер этой строки (нумерация с 1).'
			].join('\n'),
			code: { language: 'javascript', source: p.source }
		},
		answer: { kind: 'line_no', value: p.answer }
	});
	return {
		instance,
		reference: () =>
			nodeDefectProbe({
				source: p.source,
				language: 'javascript',
				check: p.check,
				line: p.answer,
				fix: p.fix,
				distractors: p.distractors.map(({ line, replacement }) => ({ line, replacement }))
			}),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const d = p.distractors.find((x) => x.wrong === id);
					return [id, d ? { kind: 'answer' as const, answer: { kind: 'line_no' as const, value: d.line } } : null];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
