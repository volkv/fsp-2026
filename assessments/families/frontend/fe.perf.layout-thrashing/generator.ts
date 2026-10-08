// Layout thrashing: which operations of a script make the browser recalculate style or lay the page out
// synchronously. A write that changes geometry invalidates style and layout, a colour write only style; a read of
// geometry flushes what is stale, a read of a layout-independent computed property flushes style only, other reads
// flush nothing. A level up: frames of `requestAnimationFrame`, microtasks, layout that is one for the whole document,
// rarer reads (`innerText`, `getComputedStyle` of a size) and two versions of the same code.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** What an operation does to the document; the text shown is built from it. */
type Api =
	| 'style.width='
	| 'style.height='
	| 'style.padding='
	| 'classList.add'
	| 'textContent='
	| 'style.color='
	| 'style.backgroundColor='
	| 'offsetHeight'
	| 'offsetWidth'
	| 'offsetTop'
	| 'clientWidth'
	| 'scrollHeight'
	| 'getBoundingClientRect'
	| 'innerText'
	| 'gcs.width'
	| 'gcs.height'
	| 'gcs.color'
	| 'gcs.fontSize'
	| 'gcs.display'
	| 'dataset'
	| 'getAttribute'
	| 'style.width'
	| 'classList.contains'
	| 'textContent';

type Kind = 'write-geometry' | 'write-paint' | 'read-layout' | 'read-style' | 'read-free';

const KIND: Record<Api, Kind> = {
	'style.width=': 'write-geometry',
	'style.height=': 'write-geometry',
	'style.padding=': 'write-geometry',
	'classList.add': 'write-geometry',
	'textContent=': 'write-geometry',
	'style.color=': 'write-paint',
	'style.backgroundColor=': 'write-paint',
	offsetHeight: 'read-layout',
	offsetWidth: 'read-layout',
	offsetTop: 'read-layout',
	clientWidth: 'read-layout',
	scrollHeight: 'read-layout',
	getBoundingClientRect: 'read-layout',
	innerText: 'read-layout',
	'gcs.width': 'read-layout',
	'gcs.height': 'read-layout',
	'gcs.color': 'read-style',
	'gcs.fontSize': 'read-style',
	'gcs.display': 'read-style',
	dataset: 'read-free',
	getAttribute: 'read-free',
	'style.width': 'read-free',
	'classList.contains': 'read-free',
	textContent: 'read-free'
};

const GCS: readonly Api[] = ['gcs.width', 'gcs.height', 'gcs.color', 'gcs.fontSize', 'gcs.display'];

interface Op {
	n: number;
	el: string;
	api: Api;
	text: string;
}

type Stmt =
	| { t: 'op'; op: Op }
	| { t: 'loop'; times: number; body: Stmt[] }
	| { t: 'raf'; body: Stmt[] }
	| { t: 'then'; body: Stmt[] };

interface Program {
	/** Elements by variable name: the selector and the subtree (container) they live in. */
	elements: { name: string; selector: string; subtree: string }[];
	/** One version of the code, or two run separately. */
	variants: Stmt[][];
	/** `exec` — tokens in the order the operations run; `number` — ascending by operation number. */
	order: 'exec' | 'number';
	/** The loop variable's element list, when the code has a loop. */
	loopList: { name: string; length: number } | null;
}

interface Rules {
	everyReadForces: boolean;
	freeReadsForce: boolean;
	colorDirtiesLayout: boolean;
	gcsAlwaysLayout: boolean;
	gcsNeverForces: boolean;
	loopFirstOnly: boolean;
	rafStartsClean: boolean;
	microtaskAfterPaint: boolean;
	nestedRafSameFrame: boolean;
	subtreeIsolated: boolean;
	innerTextFree: boolean;
}

const RIGHT: Rules = {
	everyReadForces: false,
	freeReadsForce: false,
	colorDirtiesLayout: false,
	gcsAlwaysLayout: false,
	gcsNeverForces: false,
	loopFirstOnly: false,
	rafStartsClean: false,
	microtaskAfterPaint: false,
	nestedRafSameFrame: false,
	subtreeIsolated: false,
	innerTextFree: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'every-read-forces': { everyReadForces: true },
	'free-reads-force': { freeReadsForce: true },
	'color-dirties-layout': { colorDirtiesLayout: true },
	'gcs-always-layout': { gcsAlwaysLayout: true },
	'gcs-never-forces': { gcsNeverForces: true },
	'loop-first-only': { loopFirstOnly: true },
	'raf-starts-clean': { rafStartsClean: true },
	'microtask-after-paint': { microtaskAfterPaint: true },
	'nested-raf-same-frame': { nestedRafSameFrame: true },
	'subtree-isolated': { subtreeIsolated: true },
	'innertext-free': { innerTextFree: true }
};

/** The misconceptions every instance of a class must expose; the class is built around them. */
const REQUIRED: Record<string, string[]> = {
	'middle/interleaved': ['every-read-forces', 'free-reads-force'],
	'middle/color-writes': ['color-dirties-layout', 'every-read-forces'],
	'middle/computed-style': ['gcs-always-layout', 'gcs-never-forces'],
	'middle/loop': ['loop-first-only', 'every-read-forces'],
	'senior/raf-batching': ['raf-starts-clean', 'every-read-forces'],
	'senior/two-variants': ['subtree-isolated', 'every-read-forces'],
	'senior/rare-reads': ['innertext-free', 'gcs-always-layout', 'color-dirties-layout'],
	'senior/microtask-frames': ['microtask-after-paint', 'nested-raf-same-frame']
};

// ---------------------------------------------------------------------------------------------------------------
// The model.

/** One step of the execution: an operation with its label, a frame painted, or a fresh start of a version. */
type Step = { op: Op; label: string; iteration: number } | { paint: true } | { fresh: true };

/** The order the operations run in: the script, its microtasks, then frame by frame the rAF callbacks and the paint. */
function execution(program: Program, rules: Rules): Step[] {
	const steps: Step[] = [];
	for (const variant of program.variants) {
		steps.push({ fresh: true });
		let frame: Stmt[][] = [];
		const microtasks: Stmt[][] = [];
		let current: Stmt[][] | null = null;
		const run = (stmts: readonly Stmt[], suffix: string, iteration: number): void => {
			for (const s of stmts) {
				if (s.t === 'op') steps.push({ op: s.op, label: `${s.op.n}${suffix}`, iteration });
				else if (s.t === 'loop') {
					for (let i = 1; i <= s.times; i += 1) run(s.body, `.${i}`, i);
				} else if (s.t === 'raf') {
					if (rules.nestedRafSameFrame && current) current.push(s.body);
					else frame.push(s.body);
				} else microtasks.push(s.body);
			}
		};
		const drain = (): void => {
			while (microtasks.length > 0) run(microtasks.shift() ?? [], '', 0);
		};
		run(variant, '', 0);
		if (rules.microtaskAfterPaint) steps.push({ paint: true });
		drain();
		while (frame.length > 0) {
			current = frame;
			frame = [];
			if (rules.rafStartsClean) steps.push({ paint: true });
			for (let i = 0; i < current.length; i += 1) {
				run(current[i] ?? [], '', 0);
				drain();
			}
			steps.push({ paint: true });
		}
	}
	return steps;
}

/** The forced work: `<label>L` or `<label>S` for every operation that makes the browser lay out or restyle. */
function forced(program: Program, rules: Rules): string[] {
	const subtreeOf = new Map(program.elements.map((e) => [e.name, e.subtree]));
	// Stale flags per subtree when the misconception isolates subtrees, otherwise one pair for the document.
	const stale = new Map<string, { style: boolean; layout: boolean }>();
	const scope = (el: string): string => (rules.subtreeIsolated ? (subtreeOf.get(el) ?? el) : 'document');
	const flags = (el: string): { style: boolean; layout: boolean } => {
		const key = scope(el);
		let f = stale.get(key);
		if (!f) {
			f = { style: false, layout: false };
			stale.set(key, f);
		}
		return f;
	};
	const out: { label: string; n: number; iteration: number; token: string }[] = [];
	for (const step of execution(program, rules)) {
		if (!('op' in step)) {
			stale.clear();
			continue;
		}
		const { op } = step;
		let kind = KIND[op.api];
		if (rules.gcsAlwaysLayout && GCS.includes(op.api)) kind = 'read-layout';
		if (rules.gcsNeverForces && GCS.includes(op.api)) kind = 'read-free';
		if (rules.innerTextFree && op.api === 'innerText') kind = 'read-free';
		if (rules.freeReadsForce && kind === 'read-free') kind = 'read-layout';
		if (rules.loopFirstOnly && step.iteration > 1 && kind.startsWith('read')) kind = 'read-free';
		const f = flags(op.el);
		let token: string | null = null;
		if (kind === 'write-geometry') {
			f.style = true;
			f.layout = true;
		} else if (kind === 'write-paint') {
			f.style = true;
			if (rules.colorDirtiesLayout) f.layout = true;
		} else if (kind === 'read-layout') {
			if (f.layout || rules.everyReadForces) token = 'L';
			else if (f.style) token = 'S';
			f.style = false;
			f.layout = false;
		} else if (kind === 'read-style') {
			if (f.style) token = 'S';
			f.style = false;
		}
		if (token) out.push({ label: step.label, n: op.n, iteration: step.iteration, token });
	}
	if (program.order === 'number') out.sort((a, b) => a.n - b.n || a.iteration - b.iteration);
	return out.map((o) => `${o.label}${o.token}`);
}

const answerOf = (program: Program, rules: Rules): string => {
	const tokens = forced(program, rules);
	return tokens.length === 0 ? 'нет' : tokens.join(' ');
};

// ---------------------------------------------------------------------------------------------------------------
// Building programs.

const CLASS_NAMES = ['expanded', 'wide', 'compact', 'open', 'pinned'] as const;
const COLORS = ['#c0392b', '#1e6fd9', '#2e7d32', '#6a1b9a', '#ef6c00', '#455a64'] as const;
const LABELS = ['Готово', 'Новое', 'Ещё 12', 'Скрыть', 'Все'] as const;

/** Picks a value not yet written to this property of this element; `null` when every option is used. */
type Fresh = (key: string, options: readonly string[]) => string | null;

const PX = Array.from({ length: 57 }, (_, i) => `${(i + 4) * 4}px`);
const PADDING = Array.from({ length: 6 }, (_, i) => `${(i + 1) * 4}px`);

/**
 * The text of an operation; reads keep their value in `r<n>`. A write always changes the value (the engine skips an
 * inline style set to the value it already has), so `null` means this write has no fresh value left.
 */
function opText(rng: Rng, api: Api, el: string, n: number, fresh: Fresh): string | null {
	const write = (prop: string, options: readonly string[], show: (v: string) => string): string | null => {
		const value = fresh(`${el}|${prop}`, options);
		return value === null ? null : show(value);
	};
	switch (api) {
		case 'style.width=':
			return write('width', PX, (v) => `${el}.style.width = '${v}';`);
		case 'style.height=':
			return write('height', PX, (v) => `${el}.style.height = '${v}';`);
		case 'style.padding=':
			return write('padding', PADDING, (v) => `${el}.style.padding = '${v}';`);
		case 'classList.add':
			return write('class', CLASS_NAMES, (v) => `${el}.classList.add('${v}');`);
		case 'textContent=':
			return write('text', LABELS, (v) => `${el}.textContent = '${v}';`);
		case 'style.color=':
			return write('color', COLORS, (v) => `${el}.style.color = '${v}';`);
		case 'style.backgroundColor=':
			return write('background', COLORS, (v) => `${el}.style.backgroundColor = '${v}';`);
		case 'getBoundingClientRect':
			return `const r${n} = ${el}.getBoundingClientRect().${rng.pick(['top', 'height', 'width'])};`;
		case 'gcs.width':
		case 'gcs.height':
		case 'gcs.color':
		case 'gcs.fontSize':
		case 'gcs.display':
			return `const r${n} = getComputedStyle(${el}).${api.slice(4)};`;
		case 'dataset':
			return `const r${n} = ${el}.dataset.state;`;
		case 'getAttribute':
			return `const r${n} = ${el}.getAttribute('aria-expanded');`;
		case 'style.width':
			return `const r${n} = ${el}.style.width;`;
		case 'classList.contains':
			return `const r${n} = ${el}.classList.contains('${rng.pick(CLASS_NAMES)}');`;
		default:
			return `const r${n} = ${el}.${api};`;
	}
}

const API_BY_KIND: Record<string, readonly Api[]> = {
	geometryWrite: ['style.width=', 'style.height=', 'style.padding=', 'classList.add', 'textContent='],
	paintWrite: ['style.color=', 'style.backgroundColor='],
	layoutRead: ['offsetHeight', 'offsetWidth', 'offsetTop', 'clientWidth', 'scrollHeight', 'getBoundingClientRect'],
	styleRead: ['gcs.color', 'gcs.fontSize', 'gcs.display'],
	sizeRead: ['gcs.width', 'gcs.height'],
	freeRead: ['dataset', 'getAttribute', 'style.width', 'classList.contains', 'textContent'],
	innerText: ['innerText']
};

/** A draft of an operation before numbering: which pool of APIs and which element. */
interface Draft {
	pool: keyof typeof API_BY_KIND;
	el: string;
}

type DraftStmt =
	| { t: 'op'; d: Draft }
	| { t: 'loop'; times: number; body: DraftStmt[] }
	| { t: 'raf'; body: DraftStmt[] }
	| { t: 'then'; body: DraftStmt[] };

/** Numbers the operations in source order and gives each its text. */
function realize(rng: Rng, variants: DraftStmt[][]): Stmt[][] {
	let n = 0;
	return variants.map((variant) => {
		// Every write of a version gives its property a value it has not had in this version.
		const used = new Map<string, Set<string>>();
		const fresh: Fresh = (key, options) => {
			const seen = used.get(key) ?? new Set<string>();
			const left = options.filter((o) => !seen.has(o));
			if (left.length === 0) return null;
			const value = rng.pick(left);
			seen.add(value);
			used.set(key, seen);
			return value;
		};
		const walk = (stmts: readonly DraftStmt[]): Stmt[] =>
			stmts.map((s): Stmt => {
				if (s.t !== 'op') return { ...s, body: walk(s.body) };
				n += 1;
				const pool = API_BY_KIND[s.d.pool] ?? [];
				for (const api of rng.shuffle(pool)) {
					const text = opText(rng, api, s.d.el, n, fresh);
					if (text !== null) return { t: 'op', op: { n, el: s.d.el, api, text } };
				}
				// Every value of the pool is spent on this element (possible only in theory): a width no write uses.
				const width = `${s.d.el}.style.width = '${(n + 300) * 4}px';`;
				return { t: 'op', op: { n, el: s.d.el, api: 'style.width=', text: width } };
			});
		return walk(variant);
	});
}

const PLAIN_ELEMENTS = ['header', 'sidebar', 'list', 'panel', 'footer', 'toolbar', 'badge', 'modal', 'tabs', 'banner'];

function plainElements(rng: Rng, count: number): Program['elements'] {
	return rng.sample(PLAIN_ELEMENTS, count).map((name) => ({ name, selector: `#${name}`, subtree: name }));
}

/** A weighted random draft sequence. */
function sequence(rng: Rng, length: number, weights: Partial<Record<Draft['pool'], number>>, els: string[]): Draft[] {
	const pools = Object.entries(weights) as [Draft['pool'], number][];
	const total = pools.reduce((s, [, w]) => s + w, 0);
	const out: Draft[] = [];
	for (let i = 0; i < length; i += 1) {
		let x = rng.next() * total;
		let pool = pools[0]?.[0] ?? 'layoutRead';
		for (const [p, w] of pools) {
			x -= w;
			if (x < 0) {
				pool = p;
				break;
			}
		}
		out.push({ pool, el: rng.pick(els) });
	}
	return out;
}

const ops = (drafts: readonly Draft[]): DraftStmt[] => drafts.map((d) => ({ t: 'op', d }));

function draftProgram(rng: Rng, grade: string, classId: string): Program {
	if (grade === 'middle') {
		const elements = plainElements(rng, rng.int(3, 4));
		const els = elements.map((e) => e.name);
		const length = rng.int(10, 12);
		if (classId === 'loop') {
			const pre = sequence(rng, rng.int(1, 3), { geometryWrite: 2, layoutRead: 1, freeRead: 1 }, els);
			const body = sequence(rng, rng.int(3, 5), { geometryWrite: 2, layoutRead: 2, freeRead: 1, paintWrite: 1 }, [
				'card'
			]);
			const post = sequence(rng, rng.int(1, 3), { layoutRead: 2, freeRead: 1, geometryWrite: 1 }, els);
			const times = rng.int(3, 4);
			return {
				elements,
				variants: realize(rng, [[...ops(pre), { t: 'loop', times, body: ops(body) }, ...ops(post)]]),
				order: 'exec',
				loopList: { name: 'cards', length: times }
			};
		}
		const weights: Partial<Record<Draft['pool'], number>> =
			classId === 'interleaved'
				? { geometryWrite: 3, layoutRead: 3, freeRead: 2 }
				: classId === 'color-writes'
					? { geometryWrite: 2, paintWrite: 3, layoutRead: 3, freeRead: 1 }
					: { geometryWrite: 3, layoutRead: 2, styleRead: 3, sizeRead: 1 };
		return {
			elements,
			variants: realize(rng, [ops(sequence(rng, length, weights, els))]),
			order: 'exec',
			loopList: null
		};
	}
	if (classId === 'two-variants') {
		const elements = rng.shuffle([
			{ name: 'feedTitle', selector: '#feed .title', subtree: 'feed' },
			{ name: 'feedList', selector: '#feed .list', subtree: 'feed' },
			{ name: 'sideMenu', selector: '#sidebar .menu', subtree: 'sidebar' },
			{ name: 'sideBadge', selector: '#sidebar .badge', subtree: 'sidebar' }
		]);
		const els = elements.map((e) => e.name);
		// The first version mixes reads and writes; the second reads first, then writes, then reads once more.
		const first = sequence(rng, rng.int(5, 8), { layoutRead: 3, geometryWrite: 3, freeRead: 1, paintWrite: 1 }, els);
		const reads = rng.int(2, 3);
		const second: Draft[] = [
			...sequence(rng, reads, { layoutRead: 3, freeRead: 1 }, els),
			...sequence(rng, rng.int(2, 3), { geometryWrite: 3, paintWrite: 1 }, els),
			...sequence(rng, rng.int(1, 3), { layoutRead: 3, freeRead: 1 }, els)
		];
		return { elements, variants: realize(rng, [ops(first), ops(second)]), order: 'number', loopList: null };
	}
	const elements = plainElements(rng, 4);
	const els = elements.map((e) => e.name);
	if (classId === 'rare-reads') {
		const seq = sequence(
			rng,
			rng.int(12, 14),
			{ geometryWrite: 3, paintWrite: 2, layoutRead: 1, innerText: 2, sizeRead: 2, styleRead: 2, freeRead: 2 },
			els
		);
		return { elements, variants: realize(rng, [ops(seq)]), order: 'number', loopList: null };
	}
	if (classId === 'raf-batching') {
		const sync1 = sequence(rng, rng.int(2, 3), { geometryWrite: 3, paintWrite: 1, layoutRead: 1 }, els);
		const cb1 = sequence(rng, rng.int(3, 4), { layoutRead: 3, geometryWrite: 2, styleRead: 1 }, els);
		const sync2 = sequence(rng, rng.int(2, 3), { geometryWrite: 2, layoutRead: 1, freeRead: 1 }, els);
		const cb2 = sequence(rng, rng.int(2, 3), { layoutRead: 2, geometryWrite: 2, paintWrite: 1 }, els);
		const sync3 = sequence(rng, rng.int(1, 2), { layoutRead: 2, geometryWrite: 1 }, els);
		return {
			elements,
			variants: realize(rng, [
				[...ops(sync1), { t: 'raf', body: ops(cb1) }, ...ops(sync2), { t: 'raf', body: ops(cb2) }, ...ops(sync3)]
			]),
			order: 'number',
			loopList: null
		};
	}
	// Microtasks and nested frames.
	const sync1 = sequence(rng, rng.int(2, 3), { geometryWrite: 3, layoutRead: 1 }, els);
	const micro = sequence(rng, rng.int(2, 3), { layoutRead: 2, geometryWrite: 2, freeRead: 1 }, els);
	const cbOuter = sequence(rng, rng.int(2, 3), { layoutRead: 2, geometryWrite: 2 }, els);
	const cbInner = sequence(rng, rng.int(2, 3), { layoutRead: 3, geometryWrite: 1, styleRead: 1 }, els);
	const sync2 = sequence(rng, rng.int(2, 3), { geometryWrite: 2, layoutRead: 1 }, els);
	const innerAt = rng.int(0, cbOuter.length);
	const outer: DraftStmt[] = ops(cbOuter);
	outer.splice(innerAt, 0, { t: 'raf', body: ops(cbInner) });
	const top: DraftStmt[] = [...ops(sync1), { t: 'raf', body: outer }, { t: 'then', body: ops(micro) }, ...ops(sync2)];
	if (rng.bool()) {
		// The microtask is registered before the frame callback in the source.
		const raf = top.splice(sync1.length, 1);
		top.splice(sync1.length + 1, 0, ...raf);
	}
	return { elements, variants: realize(rng, [top]), order: 'number', loopList: null };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const COMMENT_COLUMN = 52;

function codeLines(stmts: readonly Stmt[], indent: string, loopVar: string | null): string[] {
	const lines: string[] = [];
	for (const s of stmts) {
		if (s.t === 'op') {
			const text = `${indent}${s.op.text}`;
			lines.push(`${text.padEnd(Math.max(COMMENT_COLUMN, text.length + 2))}// ${s.op.n}`);
		} else if (s.t === 'loop') {
			lines.push(`${indent}for (const card of ${loopVar ?? 'cards'}) {`);
			lines.push(...codeLines(s.body, `${indent}  `, loopVar));
			lines.push(`${indent}}`);
		} else if (s.t === 'raf') {
			lines.push(`${indent}requestAnimationFrame(() => {`);
			lines.push(...codeLines(s.body, `${indent}  `, loopVar));
			lines.push(`${indent}});`);
		} else {
			lines.push(`${indent}Promise.resolve().then(() => {`);
			lines.push(...codeLines(s.body, `${indent}  `, loopVar));
			lines.push(`${indent}});`);
		}
	}
	return lines;
}

function code(program: Program): string {
	const lines = program.elements.map((e) => `const ${e.name} = document.querySelector('${e.selector}');`);
	if (program.loopList) lines.push(`const cards = document.querySelectorAll('#list .card');`);
	lines.push('');
	const variants = program.variants;
	if (variants.length === 1) lines.push(...codeLines(variants[0] ?? [], '', program.loopList?.name ?? null));
	else {
		const names = ['renderFirst', 'renderSecond'];
		variants.forEach((v, i) => {
			if (i > 0) lines.push('');
			lines.push(`function ${names[i] ?? 'render'}() {`);
			lines.push(...codeLines(v, '  ', null));
			lines.push('}');
		});
	}
	return lines.join('\n');
}

/** Every element is a rendered block box: a computed width or height of it depends on layout. */
const BOXES =
	'- все элементы отображаются и создают блочные боксы (`display: block` или `flex`; нет `display: none` и строчных `display: inline`)';

function describe(program: Program, grade: string): string {
	const senior = grade === 'senior';
	const parts = [
		`Скрипт ниже выполняется в браузере на движке Chromium${senior ? '' : ' одной задачей'}. Нас интересует, на каких операциях браузер будет вынужден синхронно, посреди скрипта, пересчитать стили или выполнить раскладку (layout).`,
		'',
		'```javascript',
		code(program),
		'```',
		'',
		'Считаем так:',
		'',
		'- у документа два признака: «стили устарели» и «раскладка устарела»; к началу скрипта (и каждого варианта) оба сняты, стили и раскладка актуальны;',
		'- записи `style.width`, `style.height`, `style.padding`, `textContent` и добавление класса (все классы в примере меняют размеры) делают устаревшими и стили, и раскладку; записи цвета и фона меняют только то, что требует пересчёта стилей; каждая запись действительно меняет значение;',
		'- если операция требует актуальной раскладки, а раскладка устарела, браузер синхронно выполняет раскладку (вместе с пересчётом стилей) — это `L`; если раскладка актуальна, а устарели только стили — синхронно пересчитывает стили, это `S`; после этого всё, что пересчитано, актуально;',
		'- если операции нужны только актуальные стили, а они устарели, — `S`, признак раскладки при этом не меняется;',
		'- какие операции чтения требуют актуальной раскладки, какие — только стилей, а какие ничего не пересчитывают, — часть задания;'
	];
	if (senior) {
		parts.push(
			'- раскладка одна на весь документ: границ раскладки (`contain: layout`, `contain: strict`) в документе нет;',
			BOXES + ';',
			'- сам, без принудительной работы, браузер пересчитывает стили и раскладку только при отрисовке кадра — в том месте обработки кадра, где это предусматривает спецификация HTML; между задачами раскладка сама не выполняется.'
		);
	} else parts.push(BOXES + '.');
	if (program.variants.length > 1) {
		parts.push(
			'',
			'Функции `renderFirst` и `renderSecond` — два варианта одного кода; каждую вызывают отдельно, в своей задаче, когда стили и раскладка актуальны. Учитывайте операции обеих функций.'
		);
	}
	if (program.loopList) {
		parts.push('', `В \`cards\` — ${program.loopList.length} элемента списка \`#list\`.`);
	}
	parts.push(
		'',
		program.order === 'exec'
			? 'Введите через пробел, в порядке выполнения, операции, на которых браузер синхронно выполнит работу: номер операции и букву `L` или `S`, например `3L 7S`.' +
					(program.loopList
						? ' Для операции внутри цикла после номера через точку укажите номер итерации с 1: `4.2L`.'
						: '') +
					' Если таких операций нет — введите `нет`.'
			: 'Введите через пробел, в порядке возрастания номеров, операции, на которых браузер синхронно выполнит работу: номер операции и букву `L` или `S`, например `3L 7S`. Если таких операций нет — введите `нет`.'
	);
	return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference.

const PYTHON_REFERENCE = `import json

p = json.loads(input())
NEEDS_LAYOUT = {"offsetHeight", "offsetWidth", "offsetTop", "clientWidth", "scrollHeight",
                "getBoundingClientRect", "innerText", "gcs.width", "gcs.height"}
NEEDS_STYLE = {"gcs.color", "gcs.fontSize", "gcs.display"}
GEOMETRY = {"style.width=", "style.height=", "style.padding=", "classList.add", "textContent="}
PAINT = {"style.color=", "style.backgroundColor="}

timeline = []


def walk(block, frames, micro, suffix=""):
    for s in block:
        if s["t"] == "op":
            timeline.append((s["op"]["n"], suffix, s["op"]["api"]))
        elif s["t"] == "loop":
            for k in range(s["times"]):
                walk(s["body"], frames, micro, "." + str(k + 1))
        elif s["t"] == "raf":
            frames.append(s["body"])
        else:
            micro.append(s["body"])


for variant in p["variants"]:
    timeline.append(None)
    frames, micro = [], []
    walk(variant, frames, micro)
    while micro:
        walk(micro.pop(0), frames, micro)
    while frames:
        now, frames = frames, []
        for cb in now:
            walk(cb, frames, micro)
            while micro:
                walk(micro.pop(0), frames, micro)
        timeline.append(None)

style_stale = layout_stale = False
hits = []
for entry in timeline:
    if entry is None:
        style_stale = layout_stale = False
        continue
    n, suffix, api = entry
    mark = ""
    if api in GEOMETRY:
        style_stale = layout_stale = True
    elif api in PAINT:
        style_stale = True
    elif api in NEEDS_LAYOUT:
        mark = "L" if layout_stale else ("S" if style_stale else "")
        style_stale = layout_stale = False
    elif api in NEEDS_STYLE:
        mark = "S" if style_stale else ""
        style_stale = False
    if mark:
        hits.append((n, int(suffix[1:]) if suffix else 0, str(n) + suffix + mark))
if p["order"] == "number":
    hits.sort(key=lambda h: (h[0], h[1]))
print(" ".join(h[2] for h in hits) if hits else "нет")
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let chosen: { program: Program; answer: string; wrong: Record<string, string | null> } | null = null;
	// Programs are drawn until every misconception the class is built around changes the answer and at least two
	// operations force work; the last draw stands if none settles (the probes below stay exact either way).
	for (let tries = 0; tries < 400; tries += 1) {
		const program = draftProgram(rng, input.grade, input.classId);
		const answer = answerOf(program, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(program, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		chosen = { program, answer, wrong };
		if (answer.split(' ').length >= 2 && required.every((id) => wrong[id] !== null)) break;
	}
	if (!chosen) throw new Error('unreachable: at least one draw');
	const { program, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(program, input.grade), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({ variants: program.variants, order: program.order })
		}),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
