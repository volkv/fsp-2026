// Page loading: in which order the scripts of a page run and when the heading first shows and DOMContentLoaded fires,
// on a simple network (each download takes RTT plus size over bandwidth, downloads run in parallel). Classic scripts
// block the parser and wait for stylesheets before them, `async` runs as soon as it arrives, `defer` and module
// scripts run after parsing in document order, a module's imports are found only after the module arrives unless
// preloaded, stylesheets block rendering, a web font with `font-display: block` hides the text until it arrives.
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

type Mode = 'classic' | 'async' | 'defer' | 'module' | 'module-async';

interface Dep {
	name: string;
	size: number;
	preloaded: boolean;
	deps: Dep[];
}

interface Script {
	kind: 'script';
	name: string;
	size: number;
	exec: number;
	mode: Mode;
	deps: Dep[];
}

interface Css {
	kind: 'css';
	name: string;
	size: number;
	font: { name: string; size: number; display: 'block' | 'swap'; preloaded: boolean } | null;
}

type Node = Script | Css | { kind: 'h1' } | { kind: 'body' };

interface Params {
	rtt: number;
	bw: number;
	nodes: Node[];
}

interface Rules {
	cssNotBlockingScripts: boolean;
	asyncDocumentOrder: boolean;
	deferDownloadOrder: boolean;
	dclWaitsAsync: boolean;
	dclBeforeDefer: boolean;
	paintIgnoresCss: boolean;
	moduleNoWaterfall: boolean;
	moduleBlocksParser: boolean;
	swapWaits: boolean;
	blockIgnored: boolean;
}

const RIGHT: Rules = {
	cssNotBlockingScripts: false,
	asyncDocumentOrder: false,
	deferDownloadOrder: false,
	dclWaitsAsync: false,
	dclBeforeDefer: false,
	paintIgnoresCss: false,
	moduleNoWaterfall: false,
	moduleBlocksParser: false,
	swapWaits: false,
	blockIgnored: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'css-not-blocking-scripts': { cssNotBlockingScripts: true },
	'async-document-order': { asyncDocumentOrder: true },
	'defer-download-order': { deferDownloadOrder: true },
	'dcl-waits-async': { dclWaitsAsync: true },
	'dcl-before-defer': { dclBeforeDefer: true },
	'paint-ignores-css': { paintIgnoresCss: true },
	'module-no-waterfall': { moduleNoWaterfall: true },
	'module-blocks-parser': { moduleBlocksParser: true },
	'swap-waits': { swapWaits: true },
	'block-ignored': { blockIgnored: true }
};

// ---------------------------------------------------------------------------------------------------------------
// The model.

/** When each script is downloaded in full (a module with its whole graph), and when the font arrives. */
function downloads(
	p: Params,
	rules: Rules
): { script: Map<string, number>; css: Map<string, number>; font: number | null } {
	const took = (size: number): number => p.rtt + size / p.bw;
	const script = new Map<string, number>();
	const css = new Map<string, number>();
	let font: number | null = null;
	const graph = (deps: readonly Dep[], parentDone: number): number => {
		let done = parentDone;
		for (const dep of deps) {
			const own = (dep.preloaded || rules.moduleNoWaterfall ? 0 : parentDone) + took(dep.size);
			done = Math.max(done, own, graph(dep.deps, own));
		}
		return done;
	};
	for (const node of p.nodes) {
		if (node.kind === 'css') {
			const done = took(node.size);
			css.set(node.name, done);
			if (node.font) font = (node.font.preloaded ? 0 : done) + took(node.font.size);
		} else if (node.kind === 'script') {
			const own = took(node.size);
			script.set(node.name, graph(node.deps, own));
		}
	}
	return { script, css, font };
}

interface Outcome {
	answer: string;
	ambiguous: boolean;
}

function simulate(p: Params, rules: Rules): Outcome {
	const dl = downloads(p, rules);
	const nodes = p.nodes;
	const blocks = (n: Node): n is Script =>
		n.kind === 'script' && (n.mode === 'classic' || (rules.moduleBlocksParser && n.mode === 'module'));
	const deferred = (n: Node): n is Script =>
		n.kind === 'script' && (n.mode === 'defer' || (n.mode === 'module' && !rules.moduleBlocksParser));
	const isAsync = (n: Node): n is Script => n.kind === 'script' && (n.mode === 'async' || n.mode === 'module-async');
	const cssBefore = (index: number): number => {
		if (rules.cssNotBlockingScripts) return 0;
		let latest = 0;
		nodes.forEach((n, i) => {
			if (i < index && n.kind === 'css') latest = Math.max(latest, dl.css.get(n.name) ?? 0);
		});
		return latest;
	};
	const allCss = Math.max(0, ...nodes.map((n) => (n.kind === 'css' ? (dl.css.get(n.name) ?? 0) : 0)));
	const fontNode = nodes.find((n): n is Css => n.kind === 'css' && n.font !== null);
	const fontWait =
		fontNode?.font && dl.font !== null
			? (fontNode.font.display === 'block' && !rules.blockIgnored) ||
				(fontNode.font.display === 'swap' && rules.swapWaits)
				? dl.font
				: 0
			: 0;

	let idx = 0;
	let parserTime = 0;
	// When the parser reached each tag: a script may run only after its tag is parsed, whatever the preload scanner
	// has fetched before.
	const reached = new Map<number, number>();
	// Moments the walk reaches; assigned inside the closures below.
	const at: { h1: number | null; parseEnd: number | null; paint: number | null; dcl: number | null } = {
		h1: null,
		parseEnd: null,
		paint: null,
		dcl: null
	};
	const advance = (): void => {
		while (idx < nodes.length) {
			const node = nodes[idx];
			if (!node || blocks(node)) return;
			reached.set(idx, parserTime);
			if (node.kind === 'h1') at.h1 = parserTime;
			idx += 1;
		}
		at.parseEnd = parserTime;
	};
	advance();
	const done = new Set<string>();
	const order: string[] = [];
	let free = 0;
	let ambiguous = false;
	const asyncs = nodes.filter(isAsync);
	const defers = nodes.filter(deferred);
	for (let guard = 0; guard < 100; guard += 1) {
		const cands: { ready: number; instant: 'paint' | 'dcl' | null; act: () => void }[] = [];
		const readyOf = new Map<string, number>();
		const run = (script: Script, after?: () => void) => (): void => {
			const start = Math.max(free, readyOf.get(script.name) ?? 0);
			free = start + script.exec;
			done.add(script.name);
			order.push(script.name);
			after?.();
		};
		const blocked = nodes[idx];
		if (blocked && blocks(blocked)) {
			const ready = Math.max(parserTime, dl.script.get(blocked.name) ?? 0, cssBefore(idx));
			readyOf.set(blocked.name, ready);
			cands.push({
				ready,
				instant: null,
				act: run(blocked, () => {
					parserTime = free;
					idx += 1;
					advance();
				})
			});
		}
		const waitingAsync = asyncs.filter((a) => !done.has(a.name));
		for (const a of rules.asyncDocumentOrder ? waitingAsync.slice(0, 1) : waitingAsync) {
			const parsedAt = reached.get(nodes.indexOf(a));
			if (parsedAt === undefined) continue;
			const ready = Math.max(dl.script.get(a.name) ?? 0, parsedAt);
			readyOf.set(a.name, ready);
			cands.push({ ready, instant: null, act: run(a) });
		}
		const parseEnd = at.parseEnd;
		if (parseEnd !== null) {
			const waitingDefer = defers.filter((d) => !done.has(d.name));
			const pool = rules.deferDownloadOrder ? waitingDefer : waitingDefer.slice(0, 1);
			for (const d of pool) {
				const ready = Math.max(parseEnd, dl.script.get(d.name) ?? 0, rules.cssNotBlockingScripts ? 0 : allCss);
				readyOf.set(d.name, ready);
				cands.push({ ready, instant: null, act: run(d) });
			}
			const defersDone = rules.dclBeforeDefer || waitingDefer.length === 0;
			const asyncDone = !rules.dclWaitsAsync || waitingAsync.length === 0;
			if (at.dcl === null && defersDone && asyncDone) {
				const ready = parseEnd;
				cands.push({ ready, instant: 'dcl', act: () => (at.dcl = Math.max(free, ready)) });
			}
		}
		const h1 = at.h1;
		if (at.paint === null && h1 !== null) {
			const ready = Math.max(h1, rules.paintIgnoresCss ? 0 : allCss, fontWait);
			cands.push({ ready, instant: 'paint', act: () => (at.paint = Math.max(free, ready)) });
		}
		if (cands.length === 0) break;
		const starts = cands.map((c) => Math.max(free, c.ready));
		const best = Math.min(...starts);
		// A script and a paint due together: the script runs first, the paint follows the task. Two scripts, or a
		// script and DOMContentLoaded, due together make the order a guess; two free moments may coincide.
		const tied = cands.filter((_, i) => starts[i] === best);
		const scriptsTied = tied.filter((c) => c.instant === null);
		if (scriptsTied.length > 1 || (scriptsTied.length > 0 && tied.some((c) => c.instant === 'dcl'))) ambiguous = true;
		(scriptsTied[0] ?? tied[0])?.act();
	}
	return { answer: [...order, at.paint ?? -1, at.dcl ?? -1].join(' '), ambiguous };
}

const solve = (p: Params, rules: Rules): string => simulate(p, rules).answer;

// ---------------------------------------------------------------------------------------------------------------
// Pages.

const size = (rng: Rng, bw: number, min: number, max: number): number =>
	rng.int(Math.ceil(min / bw), Math.floor(max / bw)) * bw;

function script(rng: Rng, bw: number, name: string, mode: Mode, min: number, max: number): Script {
	return { kind: 'script', name, size: size(rng, bw, min, max), exec: rng.int(10, 90), mode, deps: [] };
}

function css(rng: Rng, bw: number, name: string, min: number, max: number): Css {
	return { kind: 'css', name, size: size(rng, bw, min, max), font: null };
}

function page(rng: Rng, classId: string): Params {
	const rtt = rng.pick([20, 30, 40, 50, 60, 80]);
	const bw = rng.pick([1, 2, 4]);
	const scripts = rng.shuffle([
		'vendor.js',
		'widget.js',
		'analytics.js',
		'chat.js',
		'ads.js',
		'legacy.js',
		'consent.js'
	]);
	const name = (i: number): string => scripts[i % scripts.length] ?? 'app.js';
	if (classId === 'classic-css') {
		const nodes: Node[] = [css(rng, bw, 'styles.css', 120, 480)];
		if (rng.bool()) nodes.push(script(rng, bw, name(0), 'async', 20, 300));
		nodes.push({ kind: 'body' }, { kind: 'h1' }, script(rng, bw, name(1), 'classic', 10, 120));
		nodes.push(script(rng, bw, name(2), rng.pick(['async', 'defer'] as const), 20, 400));
		nodes.push(script(rng, bw, name(3), 'classic', 10, 200));
		return { rtt, bw, nodes };
	}
	if (classId === 'defer-async') {
		const scriptsInHead = rng.shuffle([
			script(rng, bw, name(0), 'defer', 150, 500),
			script(rng, bw, name(1), 'async', 100, 450),
			script(rng, bw, name(2), 'defer', 10, 120),
			script(rng, bw, name(3), 'async', 10, 150)
		]);
		return {
			rtt,
			bw,
			nodes: [css(rng, bw, 'styles.css', 40, 300), ...scriptsInHead, { kind: 'body' }, { kind: 'h1' }]
		};
	}
	if (classId === 'modules') {
		const leaf: Dep = { name: 'api.mjs', size: size(rng, bw, 20, 160), preloaded: rng.bool(0.4), deps: [] };
		const mid: Dep = { name: 'store.mjs', size: size(rng, bw, 20, 160), preloaded: rng.bool(0.4), deps: [leaf] };
		const main = script(rng, bw, 'main.mjs', 'module', 10, 80);
		main.deps.push(mid);
		if (rng.bool()) main.deps.push({ name: 'router.mjs', size: size(rng, bw, 10, 120), preloaded: false, deps: [] });
		const legacy = script(rng, bw, name(0), 'defer', 20, 400);
		const extra = script(rng, bw, name(1), rng.pick(['async', 'classic'] as const), 10, 200);
		const ordered = rng.bool() ? [main, legacy] : [legacy, main];
		return {
			rtt,
			bw,
			nodes: [css(rng, bw, 'styles.css', 40, 300), ...ordered, { kind: 'body' }, { kind: 'h1' }, extra]
		};
	}
	// Web font: font-display block or swap, preloaded or found in the CSS.
	const sheet = css(rng, bw, 'styles.css', 40, 240);
	sheet.font = {
		name: 'Inter.woff2',
		size: size(rng, bw, 40, 200),
		display: rng.pick(['block', 'swap'] as const),
		preloaded: rng.bool()
	};
	return {
		rtt,
		bw,
		nodes: [
			sheet,
			script(rng, bw, name(0), 'defer', 20, 400),
			script(rng, bw, name(1), 'async', 20, 400),
			{ kind: 'body' },
			{ kind: 'h1' },
			script(rng, bw, name(2), 'classic', 10, 160)
		]
	};
}

/** The misconceptions an instance must expose; the class and its draw decide which. */
function required(p: Params, classId: string): string[] {
	if (classId === 'classic-css') return ['css-not-blocking-scripts', 'paint-ignores-css'];
	if (classId === 'defer-async') return ['defer-download-order', 'async-document-order', 'dcl-before-defer'];
	if (classId === 'modules') return ['module-no-waterfall', 'module-blocks-parser'];
	const font = p.nodes.find((n): n is Css => n.kind === 'css')?.font;
	return font?.display === 'block' ? ['block-ignored'] : ['swap-waits'];
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function html(p: Params): string {
	const lines = ['<!doctype html>', '<html>', '<head>'];
	let inBody = false;
	const preloads: string[] = [];
	for (const node of p.nodes) {
		if (node.kind === 'css' && node.font?.preloaded)
			preloads.push(`  <link rel="preload" href="/fonts/${node.font.name}" as="font" type="font/woff2" crossorigin>`);
		if (node.kind === 'script') {
			const walk = (deps: readonly Dep[]): void => {
				for (const d of deps) {
					if (d.preloaded) preloads.push(`  <link rel="modulepreload" href="/js/${d.name}">`);
					walk(d.deps);
				}
			};
			walk(node.deps);
		}
	}
	lines.push(...preloads);
	for (const node of p.nodes) {
		if (node.kind === 'body') {
			lines.push('</head>', '<body>');
			inBody = true;
		} else if (node.kind === 'h1') lines.push(`  <h1>Каталог курсов</h1>`);
		else if (node.kind === 'css') lines.push(`  <link rel="stylesheet" href="/css/${node.name}">`);
		else {
			const attr = {
				classic: '',
				async: ' async',
				defer: ' defer',
				module: ' type="module"',
				'module-async': ' type="module" async'
			}[node.mode];
			lines.push(`  <script${attr} src="/js/${node.name}"></script>`);
		}
	}
	if (!inBody) lines.push('</head>', '<body>');
	lines.push('  <p>…</p>', '</body>', '</html>');
	return lines.join('\n');
}

function describe(p: Params): string {
	const rows: string[] = [];
	const fontCss = p.nodes.find((n): n is Css => n.kind === 'css' && n.font !== null);
	for (const node of p.nodes) {
		if (node.kind === 'css') {
			rows.push(
				`| \`${node.name}\` | ${node.size} | — | ${node.font ? `\`@font-face\` со шрифтом \`${node.font.name}\`, \`font-display: ${node.font.display}\`` : '—'} |`
			);
			if (node.font) rows.push(`| \`${node.font.name}\` | ${node.font.size} | — | шрифт заголовка \`<h1>\` |`);
		} else if (node.kind === 'script') {
			const imports = node.deps.map((d) => `\`${d.name}\``).join(', ');
			rows.push(
				`| \`${node.name}\` | ${node.size} | ${node.exec} | ${imports ? `статически импортирует ${imports}` : '—'} |`
			);
			const walk = (deps: readonly Dep[]): void => {
				for (const d of deps) {
					const inner = d.deps.map((x) => `\`${x.name}\``).join(', ');
					rows.push(`| \`${d.name}\` | ${d.size} | 0 | модуль${inner ? `, статически импортирует ${inner}` : ''} |`);
					walk(d.deps);
				}
			};
			walk(node.deps);
		}
	}
	return [
		'Браузер на движке Chromium загружает страницу:',
		'',
		'```html',
		html(p),
		'```',
		'',
		'| Ресурс | Размер, КБ | Выполнение, мс | Примечание |',
		'|---|---|---|---|',
		...rows,
		'',
		'Считаем так (упрощённая модель):',
		'',
		`- HTML получен целиком в момент 0, его разбор времени не занимает; RTT — ${p.rtt} мс, пропускная способность — ${p.bw} КБ/мс; загрузка ресурса длится RTT + размер / пропускная способность; загрузки идут параллельно и друг другу не мешают;`,
		'- все ресурсы, указанные в HTML тегами `<link>` и `<script src>`, браузер находит сканером предзагрузки и запрашивает в момент 0; шрифт из `@font-face` без предзагрузки запрашивается в момент, когда загружен CSS, где он объявлен;',
		'- сканер предзагрузки только скачивает: любой скрипт, в том числе `async`, может выполниться не раньше, чем основной разбор дойдёт до его тега;',
		'- скрипты выполняются в главном потоке по одному, время выполнения скрипта (для модуля — всего его графа) — в таблице; стили, отрисовка и события времени не занимают;',
		'- порядок выполнения скриптов, блокировки разбора и отрисовки и момент DOMContentLoaded — по спецификациям HTML и CSS; отрисовка происходит сразу, как только ей ничего не мешает и главный поток свободен;',
		fontCss
			? '- период блокировки `font-display: block` — 3 с, шрифт в задаче приходит раньше; запасной шрифт — системный;'
			: '- заголовок набран системным шрифтом;',
		'- если в один момент можно и выполнить скрипт, и отрисовать страницу, сначала выполняется скрипт: отрисовка идёт после задачи; двух скриптов (или скрипта и DOMContentLoaded), готовых в один момент, в задаче не бывает.',
		'',
		'Введите через пробел: имена скриптов в порядке выполнения (как в таблице, например `vendor.js`; модуль — именем файла, указанного в `<script>`), затем момент в мс, когда текст заголовка `<h1>` впервые виден на экране, затем момент события DOMContentLoaded. Например: `vendor.js main.mjs 420 560`.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference: a clock that ticks by one millisecond.

const PYTHON_REFERENCE = `import json

p = json.loads(input())
rtt, bw = p["rtt"], p["bw"]
nodes = p["nodes"]


def fetch(size, start=0):
    return start + rtt + size // bw


def graph_done(deps, parent):
    best = parent
    for d in deps:
        mine = fetch(d["size"], 0 if d["preloaded"] else parent)
        best = max(best, mine, graph_done(d["deps"], mine))
    return best


arrive = {}
css_at = {}
font_at = None
font_mode = None
for i, n in enumerate(nodes):
    if n["kind"] == "css":
        css_at[i] = fetch(n["size"])
        if n["font"]:
            f = n["font"]
            font_at = fetch(f["size"], 0 if f["preloaded"] else css_at[i])
            font_mode = f["display"]
    elif n["kind"] == "script":
        arrive[n["name"]] = graph_done(n["deps"], fetch(n["size"]))

scripts = [n for n in nodes if n["kind"] == "script"]
late = [n for n in scripts if n["mode"] in ("defer", "module")]
eager = [n for n in scripts if n["mode"] in ("async", "module-async")]
ran = []
pos = 0
h1_seen = None
parsed_at = None
shown = None
dcl = None
busy = 0
t = 0


def css_ready_before(i, now):
    return all(css_at[j] <= now for j in css_at if j < i)


def parse(now):
    global pos, h1_seen, parsed_at
    while pos < len(nodes):
        n = nodes[pos]
        if n["kind"] == "script" and n["mode"] == "classic":
            return
        if n["kind"] == "h1" and h1_seen is None:
            h1_seen = now
        pos += 1
    if parsed_at is None:
        parsed_at = now


parse(0)
while t < 100000 and (len(ran) < len(scripts) or shown is None or dcl is None):
    if t >= busy:
        job = None
        if pos < len(nodes):
            n = nodes[pos]
            if arrive[n["name"]] <= t and css_ready_before(pos, t):
                job = n
        if job is None:
            for n in eager:
                if n["name"] not in ran and nodes.index(n) < pos and arrive[n["name"]] <= t:
                    job = n
                    break
        if job is None and parsed_at is not None:
            nxt = next((n for n in late if n["name"] not in ran), None)
            if nxt and arrive[nxt["name"]] <= t and all(v <= t for v in css_at.values()):
                job = nxt
        if job is not None:
            ran.append(job["name"])
            busy = t + job["exec"]
            if job["mode"] == "classic":
                pos += 1
                parse(busy)
            continue
        if shown is None and h1_seen is not None and h1_seen <= t and all(v <= t for v in css_at.values()):
            if font_mode != "block" or font_at <= t:
                shown = t
        if dcl is None and parsed_at is not None and parsed_at <= t and all(n["name"] in ran for n in late):
            dcl = t
    t += 1
print(" ".join(ran + [str(shown), str(dcl)]))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	let chosen: { p: Params; answer: string; wrong: Record<string, string | null> } | null = null;
	// Pages are drawn until no moment is ambiguous and every misconception the class is built around changes the
	// answer; the last draw stands if none settles (the probes stay exact either way).
	for (let tries = 0; tries < 400; tries += 1) {
		const p = page(rng, input.classId);
		const { answer, ambiguous } = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		// An ambiguous draw is kept only while nothing better has come.
		if (!chosen || !ambiguous) chosen = { p, answer, wrong };
		if (!ambiguous && required(p, input.classId).every((id) => wrong[id] !== null)) break;
	}
	if (!chosen) throw new Error('unreachable: at least one draw');
	const { p, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(p), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
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
