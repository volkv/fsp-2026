// Practice: a summary of a web server's access log by the rule the class sets (p95 latency by nearest rank, the share
// of 5xx with rounding, the top clients or paths by bytes, distinct clients or the peak per minute). Broken lines are
// skipped by an explicit rule and counted; from Junior up paths are normalized (query string, numeric segments, the
// trailing slash) and several rules of selection act together. Parametric hidden tests in five groups.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['python3', 'go'] as const;

const descriptor = readDescriptor(import.meta.url);

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
/** Valid statuses of generated lines; 599 and 1xx never occur, so a shifted edge of a 5xx check stays invisible. */
const STATUSES = [200, 200, 200, 200, 200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 429, 500, 502, 503, 504];
const INTERN_PATHS = [
	'/api/orders',
	'/api/users',
	'/api/cart',
	'/api/items',
	'/api/payments',
	'/login',
	'/logout',
	'/health',
	'/metrics',
	'/search',
	'/static/app.js',
	'/static/app.css',
	'/admin',
	'/api/v2/orders'
] as const;
/** Junior paths: `{id}` becomes a number, `{n}` a small number, `{w}` a word. */
const JUNIOR_TEMPLATES = [
	'/api/users/{id}',
	'/api/users/{id}/orders',
	'/api/orders/{id}',
	'/api/orders',
	'/api/orders/',
	'/api/orders?page={n}',
	'/api/users?active={n}',
	'/health',
	'/health/',
	'/',
	'/search?q={w}',
	'/api/items/{id}/',
	'/api/v2/orders/{id}/items',
	'/static/app.js',
	'/api/users/{id}/?full={n}'
] as const;
const WORDS = ['phone', 'tv', 'case', 'cable', 'lamp', 'book', 'chair', 'desk'] as const;

interface Rec {
	/** Seconds since midnight; a line broken by range keeps its out-of-range parts in `time`. */
	time: string;
	client: string;
	method: string;
	path: string;
	status: number;
	/** `null` is written as `-` and counts as 0 bytes. */
	bytes: number | null;
	ms: number;
}
type Broken = null | 'shape' | 'range';
interface Line {
	rec: Rec;
	raw: string;
	broken: Broken;
}
/** `k` — K of the top classes, `m` — M of the Junior share of errors; 0 where the class has none. */
interface Input {
	k: number;
	m: number;
	lines: Line[];
}

const WRONG_IDS = [
	'range-unchecked',
	'dash-skipped',
	'percentile-floor',
	'rate-truncated',
	'no-tie-break',
	'requests-not-clients',
	'peak-tie-latest',
	'query-kept',
	'ids-kept'
] as const;
type Variant = 'right' | (typeof WRONG_IDS)[number];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pad = (x: number, width = 2): string => String(x).padStart(width, '0');
const clock = (t: number): string => `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;

function render(rec: Rec): string {
	return `${rec.time} ${rec.client} ${rec.method} ${rec.path} ${pad(rec.status, 3)} ${rec.bytes ?? '-'} ${rec.ms}`;
}

function normalize(path: string, junior: boolean, variant: Variant): string {
	if (!junior) return path;
	let p = variant === 'query-kept' ? path : (path.split('?')[0] ?? '');
	if (variant !== 'ids-kept')
		p = p
			.split('/')
			.map((s) => (/^[0-9]+$/.test(s) ? ':id' : s))
			.join('/');
	if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
	return p;
}

/** The lines a solution reads as valid and the number it skips. */
function parse(input: Input, variant: Variant): { recs: Rec[]; skipped: number } {
	const recs: Rec[] = [];
	let skipped = 0;
	for (const line of input.lines) {
		const ok =
			line.broken === null
				? !(line.rec.bytes === null && variant === 'dash-skipped')
				: line.broken === 'range' && variant === 'range-unchecked';
		if (ok) recs.push(line.rec);
		else skipped += 1;
	}
	return { recs, skipped };
}

function nearestRank(values: readonly number[], variant: Variant): number {
	const v = [...values].sort((a, b) => a - b);
	const n = v.length;
	const index =
		variant === 'percentile-floor' ? Math.min(n - 1, Math.floor((95 * n) / 100)) : Math.ceil((95 * n) / 100) - 1;
	return v[index] ?? 0;
}

/** The share in tenths of a percent, rounded half up (or truncated by the wrong solution). */
function tenths(errors: number, total: number, variant: Variant): number {
	const q = Math.floor((errors * 1000) / total);
	const r = (errors * 1000) % total;
	return variant !== 'rate-truncated' && 2 * r >= total ? q + 1 : q;
}
const percent = (t: number): string => `${Math.floor(t / 10)}.${t % 10}`;

const is5xx = (status: number): boolean => Math.floor(status / 100) === 5;
const below400 = (status: number): boolean => Math.floor(status / 100) < 4;

/** The output of the class on an input; a variant other than `right` reproduces a wrong solution. */
function solve(cls: string, junior: boolean, input: Input, variant: Variant = 'right'): string {
	const { recs, skipped } = parse(input, variant);
	const path = (r: Rec): string => normalize(r.path, junior, variant);
	const out: string[] = [];
	const groupBy = <T>(
		keyOf: (r: Rec) => string | null,
		init: () => T,
		add: (acc: T, r: Rec) => void
	): Map<string, T> => {
		const map = new Map<string, T>();
		for (const r of recs) {
			const key = keyOf(r);
			if (key === null) continue;
			let acc = map.get(key);
			if (acc === undefined) {
				acc = init();
				map.set(key, acc);
			}
			add(acc, r);
		}
		return map;
	};
	if (cls === 'p95-latency') {
		const by = groupBy(
			(r) =>
				!junior
					? path(r)
					: Math.floor(r.status / 100) === 2 || Math.floor(r.status / 100) === 3
						? `${path(r)} ${r.method}`
						: null,
			(): number[] => [],
			(acc, r) => acc.push(r.ms)
		);
		for (const key of [...by.keys()].sort(cmp)) out.push(`${key} ${nearestRank(by.get(key) ?? [], variant)}`);
	} else if (cls === 'error-rate') {
		const by = groupBy(
			path,
			() => ({ total: 0, errors: 0 }),
			(acc, r) => {
				acc.total += 1;
				if (is5xx(r.status)) acc.errors += 1;
			}
		);
		const rows = [...by]
			.filter(([, c]) => !junior || c.total >= input.m)
			.map(([key, c]) => ({ key, t: tenths(c.errors, c.total, variant) }))
			.sort((a, b) => b.t - a.t || cmp(a.key, b.key));
		for (const row of rows) out.push(`${row.key} ${percent(row.t)}`);
	} else if (cls === 'top-clients' || cls === 'top-paths') {
		const by = groupBy(
			(r) => (cls === 'top-clients' ? r.client : below400(r.status) ? path(r) : null),
			() => ({ sum: 0 }),
			(acc, r) => {
				acc.sum += r.bytes ?? 0;
			}
		);
		const rows = [...by].sort((a, b) => b[1].sum - a[1].sum || (variant === 'no-tie-break' ? 0 : cmp(a[0], b[0])));
		for (const [key, acc] of rows.slice(0, input.k)) out.push(`${key} ${acc.sum}`);
	} else if (cls === 'unique-per-minute') {
		const by = groupBy(
			(r) => r.time.slice(0, 5),
			(): string[] => [],
			(acc, r) => acc.push(r.client)
		);
		for (const minute of [...by.keys()].sort(cmp)) {
			const clients = by.get(minute) ?? [];
			out.push(`${minute} ${variant === 'requests-not-clients' ? clients.length : new Set(clients).size}`);
		}
	} else {
		const by = groupBy(
			path,
			() => new Map<string, number>(),
			(acc, r) => acc.set(r.time.slice(0, 5), (acc.get(r.time.slice(0, 5)) ?? 0) + 1)
		);
		for (const key of [...by.keys()].sort(cmp)) {
			const counts = by.get(key) ?? new Map<string, number>();
			let best = '';
			let most = 0;
			for (const minute of [...counts.keys()].sort(cmp)) {
				const c = counts.get(minute) ?? 0;
				if (c > most || (variant === 'peak-tie-latest' && c === most)) [best, most] = [minute, c];
			}
			out.push(`${key} ${best} ${most}`);
		}
	}
	if (out.length === 0) return '';
	return `${[...out, `skipped ${skipped}`].join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs.

interface Scene {
	rng: Rng;
	junior: boolean;
	clients: string[];
	paths: string[];
	/** The first second of the log and its span in seconds. */
	start: number;
	span: number;
}

function ips(rng: Rng, count: number): string[] {
	const pool = new Set<string>();
	const net = rng.int(0, 3);
	while (pool.size < count) pool.add(`10.${net}.${rng.int(0, 30)}.${rng.int(1, 254)}`);
	return [...pool];
}

function expand(rng: Rng, template: string): string {
	return template
		.replace('{id}', String(rng.int(1, 99_999)))
		.replace('{id}', String(rng.int(1, 999)))
		.replace('{n}', String(rng.int(1, 9)))
		.replace('{w}', rng.pick(WORDS));
}

function scene(rng: Rng, junior: boolean, clients: number, paths: number, minutes: number): Scene {
	const span = minutes * 60;
	return {
		rng,
		junior,
		clients: ips(rng, clients),
		paths: rng.sample(
			junior ? JUNIOR_TEMPLATES : INTERN_PATHS,
			Math.min(paths, junior ? JUNIOR_TEMPLATES.length : INTERN_PATHS.length)
		),
		start: rng.int(0, 86_399 - span - 120),
		span
	};
}

interface RecOptions {
	path?: string;
	client?: string;
	status?: number;
	method?: string;
	minute?: number;
	ms?: number;
	bytes?: number | null;
	t?: number;
}

/** A valid record at a random moment of the scene; `minute` pins it to that minute of the span. */
function record(s: Scene, o: RecOptions = {}): { t: number; rec: Rec } {
	const { rng } = s;
	const t =
		o.t ??
		(o.minute === undefined
			? s.start + rng.int(0, s.span - 1)
			: Math.floor(s.start / 60) * 60 + (o.minute + 1) * 60 + rng.int(0, 59));
	const status = o.status ?? rng.pick(STATUSES);
	const template = o.path ?? rng.pick(s.paths);
	const rec: Rec = {
		time: clock(t),
		client: o.client ?? rng.pick(s.clients),
		method: o.method ?? (rng.bool(0.6) ? 'GET' : rng.pick(METHODS)),
		path: s.junior ? expand(rng, template) : template,
		status,
		bytes:
			o.bytes !== undefined
				? o.bytes
				: rng.bool(status === 204 || status === 304 ? 0.6 : 0.06)
					? null
					: rng.int(0, 60_000),
		ms: o.ms ?? rng.int(1, 3000)
	};
	return { t, rec };
}

const SHAPE_BREAKS = ['short', 'long', 'time', 'method', 'path', 'status', 'bytes', 'ms'] as const;
const RANGE_BREAKS = ['hour', 'minute', 'second', 'status-low', 'status-high'] as const;

/** A line broken by its shape (any solution skips it) or by a range only. */
function breakLine(rng: Rng, rec: Rec, kind: (typeof SHAPE_BREAKS)[number] | (typeof RANGE_BREAKS)[number]): Line {
	const fields = render(rec).split(' ');
	const [hh, mm, ss] = rec.time.split(':');
	const set = (i: number, value: string): string => fields.map((f, j) => (j === i ? value : f)).join(' ');
	switch (kind) {
		case 'short':
			return { rec, raw: fields.slice(0, rng.int(4, 6)).join(' '), broken: 'shape' };
		case 'long':
			return {
				rec,
				raw: [...fields.slice(0, 4), rng.pick(['HTTP/1.1', 'HTTP/2.0']), ...fields.slice(4)].join(' '),
				broken: 'shape'
			};
		case 'time':
			return {
				rec,
				raw: set(
					0,
					Number(hh) < 10 && rng.bool() ? `${Number(hh)}:${mm}:${ss}` : rng.pick([`${hh}-${mm}-${ss}`, `${hh}:${mm}`])
				),
				broken: 'shape'
			};
		case 'method':
			return {
				rec,
				raw: set(2, rng.bool() ? rec.method.toLowerCase() : rng.pick(['FETCH', 'OPTION', 'Get'])),
				broken: 'shape'
			};
		case 'path':
			return { rec, raw: set(3, rec.path.slice(1) || 'index'), broken: 'shape' };
		case 'status':
			return { rec, raw: set(4, rng.pick(['5xx', '20', '2000', 'OK', '-'])), broken: 'shape' };
		case 'bytes':
			return { rec, raw: set(5, rng.bool() ? `${rng.int(1, 90)}k` : `-${rng.int(1, 900)}`), broken: 'shape' };
		case 'ms':
			return { rec, raw: set(6, rng.bool() ? `${rec.ms}ms` : `${rec.ms}.${rng.int(1, 9)}`), broken: 'shape' };
		case 'hour':
		case 'minute':
		case 'second': {
			const value = rng.pick([kind === 'hour' ? 24 : 60, kind === 'hour' ? 24 : 60, kind === 'hour' ? 27 : 75]);
			const time =
				kind === 'hour' ? `${value}:${mm}:${ss}` : kind === 'minute' ? `${hh}:${value}:${ss}` : `${hh}:${mm}:${value}`;
			const bad = { ...rec, time };
			return { rec: bad, raw: render(bad), broken: 'range' };
		}
		case 'status-low':
		case 'status-high': {
			const bad = { ...rec, status: kind === 'status-low' ? rng.pick([0, 42, 99]) : rng.pick([600, 600, 700, 999]) };
			return { rec: bad, raw: render(bad), broken: 'range' };
		}
	}
}

type GroupId = 'basic' | 'broken' | 'boundary' | 'many' | 'normalize' | 'scale';

/** Valid lines in the order of time, with a few neighbours swapped: several workers write one file. */
function arrange(rng: Rng, items: { t: number; rec: Rec }[], broken: Line[]): Line[] {
	const sorted = [...items].sort((a, b) => a.t - b.t);
	for (let i = 0; i + 1 < sorted.length; i += 1) {
		if (rng.bool(0.15))
			[sorted[i], sorted[i + 1]] = [sorted[i + 1] as { t: number; rec: Rec }, sorted[i] as { t: number; rec: Rec }];
	}
	const lines: Line[] = sorted.map((x) => ({ rec: x.rec, raw: render(x.rec), broken: null }));
	for (const b of broken) lines.splice(rng.int(0, lines.length), 0, b);
	return lines;
}

function brokenLines(rng: Rng, s: Scene, shape: number, range: number): Line[] {
	const out: Line[] = [];
	for (let i = 0; i < shape; i += 1) out.push(breakLine(rng, record(s).rec, rng.pick(SHAPE_BREAKS)));
	for (let i = 0; i < range; i += 1) out.push(breakLine(rng, record(s).rec, rng.pick(RANGE_BREAKS)));
	return out;
}

/** The class's own edge: ranks at a multiple of 20, exact halves, ties of the top, repeated clients, tied peaks. */
function boundaryItems(s: Scene, cls: string, m: number): { t: number; rec: Rec }[] {
	const { rng, junior } = s;
	const items: { t: number; rec: Rec }[] = [];
	if (cls === 'p95-latency') {
		const keys = rng.sample(s.paths, Math.min(s.paths.length, rng.int(2, 3)));
		keys.forEach((path, i) => {
			const count = i === 0 ? rng.pick([20, 40]) : rng.pick([20, 40, 13, 7]);
			const method = rng.pick(METHODS);
			const ms = rng.sample(
				Array.from({ length: 3000 }, (_, j) => j + 1),
				count
			);
			for (const value of ms)
				items.push(record(s, { path, method, ms: value, status: junior ? rng.pick([200, 201, 302, 304]) : undefined }));
			if (junior)
				for (let j = rng.int(1, 4); j > 0; j -= 1)
					items.push(record(s, { path, method, status: rng.pick([400, 404, 500, 503]) }));
		});
	} else if (cls === 'error-rate') {
		const keys = rng.sample(s.paths, Math.min(s.paths.length, junior ? 4 : 3));
		keys.forEach((path, i) => {
			// The first path sits on an exact half of a tenth; on Junior the next two sit at M and just below it.
			const total = i === 0 ? 16 : junior && i === 1 ? m : junior && i === 2 ? m - 1 : rng.int(5, 30);
			const errors = i === 0 ? rng.pick([1, 3, 5, 7, 9, 11, 13, 15]) : rng.int(0, total);
			for (let j = 0; j < total; j += 1)
				items.push(
					record(s, { path, status: j < errors ? rng.pick([500, 502, 503, 504]) : rng.pick([200, 201, 304, 404]) })
				);
		});
	} else if (cls === 'top-clients' || cls === 'top-paths') {
		for (let j = rng.int(6, 14); j > 0; j -= 1) items.push(record(s));
		// Two keys tie at the top; the one later in sort order comes first in the log.
		const keys =
			cls === 'top-clients'
				? ips(rng, s.clients.length + 2)
						.filter((ip) => !s.clients.includes(ip))
						.slice(0, 2)
				: rng.sample(s.paths, 2);
		const [low, high] = [...keys].sort(cmp) as [string, string];
		const total = 200_000 + rng.int(0, 50_000);
		const parts = rng.int(2, 3);
		const split = Array.from({ length: parts }, (_, j) =>
			j === parts - 1 ? total - Math.floor(total / parts) * (parts - 1) : Math.floor(total / parts)
		);
		for (const key of [high, low]) {
			for (const bytes of split) {
				const t = key === high ? s.start : undefined;
				items.push(record(s, cls === 'top-clients' ? { client: key, bytes, t } : { path: key, bytes, status: 200, t }));
			}
		}
	} else if (cls === 'unique-per-minute') {
		const few = rng.sample(s.clients, Math.min(s.clients.length, rng.int(2, 3)));
		for (let j = rng.int(14, 24); j > 0; j -= 1) items.push(record(s, { client: rng.pick(few) }));
	} else {
		// A path whose peak is shared by two minutes.
		const path = rng.pick(s.paths);
		const minutes = Math.floor(s.span / 60) - 1;
		const [a, b] = rng.sample(
			Array.from({ length: minutes }, (_, j) => j),
			2
		) as [number, number];
		const peak = rng.int(3, 4);
		for (let minute = 0; minute < minutes; minute += 1) {
			const count = minute === a || minute === b ? peak : rng.int(0, peak - 1);
			for (let j = 0; j < count; j += 1) items.push(record(s, { path, minute }));
		}
		for (let j = rng.int(6, 12); j > 0; j -= 1)
			items.push(record(s, { path: rng.pick(s.paths.filter((p) => p !== path)) }));
	}
	return items;
}

function distinctTemplates(rng: Rng, count: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const template of rng.shuffle(JUNIOR_TEMPLATES)) {
		const key = normalize(template.replace(/\{\w+\}/g, '1'), true, 'right');
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(template);
	}
	return out.slice(0, count);
}

function makeInput(rng: Rng, cls: string, group: GroupId, junior: boolean): Input {
	const m = junior && cls === 'error-rate' ? rng.int(3, 8) : 0;
	const sizes: Record<GroupId, [number, number, number, number]> = {
		// clients, paths, minutes, valid lines
		basic: [rng.int(3, 6), rng.int(2, 4), rng.int(2, 4), rng.int(10, 20)],
		broken: [rng.int(3, 6), rng.int(2, 4), rng.int(2, 4), rng.int(10, 18)],
		boundary: [rng.int(3, 6), rng.int(3, 5), rng.int(3, 5), 0],
		many: [rng.int(15, 30), rng.int(8, 12), rng.int(10, 20), rng.int(40, 80)],
		normalize: [rng.int(3, 6), rng.int(6, 9), rng.int(2, 4), rng.int(20, 36)],
		scale: [rng.int(150, 250), junior ? 15 : 12, rng.int(40, 90), rng.int(2000, 3000)]
	};
	const [clientCount, pathCount, minutes, count] = sizes[group];
	const s = scene(rng, junior, clientCount, pathCount, minutes);
	if (group === 'normalize' && !s.paths.includes('/')) s.paths.push('/');
	// The edges of the summary need keys that stay apart after normalization.
	if (group === 'boundary' && junior) s.paths = distinctTemplates(rng, pathCount);
	const items = group === 'boundary' ? boundaryItems(s, cls, m) : [];
	for (let i = 0; i < count; i += 1) items.push(record(s));
	const broken =
		group === 'broken'
			? brokenLines(rng, s, rng.int(2, 5), rng.int(1, 3))
			: group === 'scale'
				? brokenLines(rng, s, rng.int(40, 80), rng.int(15, 30))
				: group === 'many'
					? brokenLines(rng, s, rng.int(1, 3), rng.int(0, 2))
					: [];
	if (group === 'broken') items.push(record(s, { bytes: null }));
	const keys = cls === 'top-clients' ? new Set(items.map((x) => x.rec.client)).size : s.paths.length;
	const k =
		cls === 'top-clients' || cls === 'top-paths'
			? group === 'many'
				? rng.int(3, keys + 5)
				: rng.int(2, Math.max(2, keys))
			: 0;
	return { k, m, lines: arrange(rng, items, broken) };
}

function renderInput(cls: string, input: Input): string {
	const head =
		cls === 'top-clients' || cls === 'top-paths'
			? `${input.lines.length} ${input.k}`
			: input.m > 0
				? `${input.lines.length} ${input.m}`
				: `${input.lines.length}`;
	return `${[head, ...input.lines.map((l) => l.raw)].join('\n')}\n`;
}

/** The wrong solutions a group must expose on every test of the class. */
function traps(cls: string, group: GroupId): Variant[] {
	if (group === 'broken') return ['range-unchecked', 'dash-skipped'];
	if (group === 'normalize') return ['query-kept', 'ids-kept'];
	if (group !== 'boundary') return [];
	const own: Record<string, Variant> = {
		'p95-latency': 'percentile-floor',
		'error-rate': 'rate-truncated',
		'top-clients': 'no-tie-break',
		'top-paths': 'no-tie-break',
		'unique-per-minute': 'requests-not-clients',
		'peak-minute': 'peak-tie-latest'
	};
	const v = own[cls];
	return v ? [v] : [];
}

function groups(rng: Rng, cls: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	const ids: GroupId[] = junior
		? ['basic', 'broken', 'normalize', 'boundary', 'scale']
		: ['basic', 'broken', 'boundary', 'many', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 2 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${cls}`);
			const input = makeInput(rng, cls, id, junior);
			const expected = solve(cls, junior, input);
			if (expected.split('\n').length < 3) continue;
			if (others.some((other) => solve(other, junior, input) === expected)) continue;
			if (traps(cls, id).some((v) => solve(cls, junior, input, v) === expected)) continue;
			tests.push({ stdin: renderInput(cls, input), expected });
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

const RULES: Record<string, (junior: boolean) => string> = {
	'p95-latency': (junior) =>
		`${junior ? 'Для каждой пары «нормализованный путь, метод» по строкам со статусом 2xx или 3xx (остальные статусы в расчёт не входят)' : 'Для каждого пути'} найдите p95 времени ответа методом ближайшего ранга: отсортируйте значения по возрастанию, r = ⌈0,95·n⌉, где n — их число; p95 — r-е значение (нумерация с 1). Выведите строки \`${junior ? '<путь> <метод> <p95>' : '<путь> <p95>'}\`${junior ? ' — по пути, при равном пути — по методу' : ' — по пути'} в лексикографическом порядке.${junior ? ' Пары без строк 2xx и 3xx не выводите.' : ''}`,
	'error-rate': (junior) =>
		`Для каждого ${junior ? 'нормализованного пути, по которому не меньше `M` верных строк,' : 'пути'} найдите долю ответов со статусом 500–599 среди его строк в процентах, округлённую до десятых по правилу «половина вверх» (12,25 → 12,3; 12,24 → 12,2). Выведите строки \`<путь> <доля>\`, доля — ровно с одной цифрой после точки (\`33.3\`, \`0.0\`, \`100.0\`). Порядок — по убыванию доли, при равенстве — по пути в лексикографическом порядке.${junior ? ' Пути, у которых меньше `M` строк, не выводите.' : ''} Совет: считайте в целых числах — дроби с плавающей точкой ошибаются ровно на половинах.`,
	'top-clients': () =>
		'Посчитайте для каждого клиента сумму байт всех его строк (`-` — это 0 байт). Выведите `K` клиентов с наибольшей суммой строками `<клиент> <байты>`: по убыванию суммы, при равенстве — по адресу клиента как по строке в лексикографическом порядке. Если клиентов меньше `K`, выведите всех.',
	'top-paths': () =>
		'Посчитайте для каждого нормализованного пути сумму байт его строк со статусом меньше 400 (`-` — это 0 байт; строки со статусом 400 и больше не учитываются, путь только с такими строками не участвует). Выведите `K` путей с наибольшей суммой строками `<путь> <байты>`: по убыванию суммы, при равенстве — по пути в лексикографическом порядке. Если путей меньше `K`, выведите всех.',
	'unique-per-minute': () =>
		'Для каждой минуты `HH:MM`, в которой есть хотя бы одна верная строка, посчитайте число **разных** клиентов. Выведите строки `<HH:MM> <число>` в порядке времени.',
	'peak-minute': () =>
		'Для каждого нормализованного пути найдите минуту `HH:MM`, в которой у него больше всего верных строк; при равенстве — самую раннюю такую минуту. Выведите строки `<путь> <HH:MM> <число строк>` по пути в лексикографическом порядке.'
};

function statement(cls: string, junior: boolean): string {
	const k = cls === 'top-clients' || cls === 'top-paths';
	const m = junior && cls === 'error-rate';
	return [
		'Веб-сервер пишет журнал доступа: одна строка — один запрос. Напишите программу, которая читает журнал со стандартного ввода и печатает сводку.',
		'',
		'## Вход',
		'',
		`В первой строке — ${k ? '`N K`: число строк журнала (1 ≤ N ≤ 10⁴) и K (1 ≤ K ≤ 1000)' : m ? '`N M`: число строк журнала (1 ≤ N ≤ 10⁴) и M (1 ≤ M ≤ 1000)' : 'число строк журнала `N` (1 ≤ N ≤ 10⁴)'}. Далее \`N\` строк журнала. Верная строка — ровно семь полей через пробел:`,
		'',
		'```',
		'<время> <клиент> <метод> <путь> <статус> <байты> <мс>',
		'14:03:27 10.1.7.31 GET /api/orders 200 5120 34',
		'```',
		'',
		'- время — `HH:MM:SS`, ровно по две цифры, часы 00–23, минуты и секунды 00–59;',
		'- клиент — адрес без пробелов (не проверяется);',
		'- метод — `GET`, `POST`, `PUT`, `DELETE` или `PATCH` (заглавными буквами);',
		'- путь начинается с `/`;',
		'- статус — ровно три цифры, число от 100 до 599;',
		'- байты — целое неотрицательное число из цифр или `-` (это 0 байт);',
		'- мс — время ответа, целое неотрицательное число из цифр.',
		'',
		'Строка, нарушающая хоть одно правило, — битая: её пропускают и считают. Несколько воркеров пишут в один файл, поэтому строки идут примерно, но не строго по времени.',
		...(junior
			? [
					'',
					'## Нормализация пути',
					'',
					'Во всех расчётах путь сначала нормализуется, по порядку: (1) отрезается строка запроса — всё начиная с первого `?`; (2) каждый сегмент между `/`, состоящий только из цифр, заменяется на `:id`; (3) убирается `/` в конце, если путь длиннее одного символа. Пример: `/api/users/42/?full=1` → `/api/users/:id`, `/api/v2/orders` не меняется, `/` остаётся `/`.'
				]
			: []),
		'',
		'## Выход',
		'',
		RULES[cls]?.(junior) ?? '',
		'',
		'Последняя строка вывода — `skipped <число битых строк>`.',
		'',
		`Скрытые тесты — пять групп: ${junior ? 'обычные данные, битые строки, нормализация путей, граничные случаи правила сводки, большой объём' : 'обычные данные, битые строки, граничные случаи правила сводки, много ключей, большой объём'}. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Reference programs.

function referenceSource(cls: string, junior: boolean, variant: Variant): string {
	const time =
		variant === 'range-unchecked' ? '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' : '([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]';
	const status = variant === 'range-unchecked' ? '[0-9][0-9][0-9]' : '[1-5][0-9][0-9]';
	const size = variant === 'dash-skipped' ? 'NUMBER.fullmatch(f[5])' : "(f[5] == '-' or NUMBER.fullmatch(f[5]))";
	const header =
		cls === 'top-clients' || cls === 'top-paths'
			? 'n, k = map(int, lines[0].split())'
			: junior && cls === 'error-rate'
				? 'n, m = map(int, lines[0].split())'
				: 'n = int(lines[0])';
	const normalize = junior
		? [
				'',
				'def normalize(path):',
				...(variant === 'query-kept' ? [] : ["    path = path.split('?')[0]"]),
				...(variant === 'ids-kept'
					? []
					: ["    path = '/'.join(':id' if s.isdigit() else s for s in path.split('/'))"]),
				"    if len(path) > 1 and path.endswith('/'):",
				'        path = path[:-1]',
				'    return path',
				''
			]
		: [];
	const rank =
		variant === 'percentile-floor' ? 'v[min(len(v) - 1, 95 * len(v) // 100)]' : 'v[(95 * len(v) + 99) // 100 - 1]';
	const body: Record<string, string[]> = {
		'p95-latency': [
			'by = {}',
			'for minute, client, method, path, status, size, ms in records:',
			...(junior
				? ['    if status // 100 in (2, 3):', '        by.setdefault((path, method), []).append(ms)']
				: ['    by.setdefault(path, []).append(ms)']),
			'for key in sorted(by):',
			'    v = sorted(by[key])',
			junior ? `    print(key[0], key[1], ${rank})` : `    print(key, ${rank})`
		],
		'error-rate': [
			'by = {}',
			'for minute, client, method, path, status, size, ms in records:',
			'    c = by.setdefault(path, [0, 0])',
			'    c[0] += 1',
			'    if status // 100 == 5:',
			'        c[1] += 1',
			'rows = []',
			'for path, (total, errors) in by.items():',
			...(junior ? ['    if total < m:', '        continue'] : []),
			'    q, r = divmod(errors * 1000, total)',
			...(variant === 'rate-truncated' ? [] : ['    if 2 * r >= total:', '        q += 1']),
			'    rows.append((-q, path))',
			'for nq, path in sorted(rows):',
			'    q = -nq',
			"    print(path, f'{q // 10}.{q % 10}')"
		],
		'top-clients': [
			'total = {}',
			'for minute, client, method, path, status, size, ms in records:',
			'    total[client] = total.get(client, 0) + size',
			`for key, size in sorted(total.items(), key=lambda r: ${variant === 'no-tie-break' ? '-r[1]' : '(-r[1], r[0])'})[:k]:`,
			'    print(key, size)'
		],
		'top-paths': [
			'total = {}',
			'for minute, client, method, path, status, size, ms in records:',
			'    if status // 100 < 4:',
			'        total[path] = total.get(path, 0) + size',
			`for key, size in sorted(total.items(), key=lambda r: ${variant === 'no-tie-break' ? '-r[1]' : '(-r[1], r[0])'})[:k]:`,
			'    print(key, size)'
		],
		'unique-per-minute': [
			'seen = {}',
			'for minute, client, method, path, status, size, ms in records:',
			variant === 'requests-not-clients'
				? '    seen.setdefault(minute, []).append(client)'
				: '    seen.setdefault(minute, set()).add(client)',
			'for minute in sorted(seen):',
			'    print(minute, len(seen[minute]))'
		],
		'peak-minute': [
			'count = {}',
			'for minute, client, method, path, status, size, ms in records:',
			'    per = count.setdefault(path, {})',
			'    per[minute] = per.get(minute, 0) + 1',
			'for path in sorted(count):',
			'    per = count[path]',
			'    best = None',
			'    for minute in sorted(per):',
			`        if best is None or per[minute] ${variant === 'peak-tie-latest' ? '>=' : '>'} per[best]:`,
			'            best = minute',
			'    print(path, best, per[best])'
		]
	};
	return [
		'import re',
		'import sys',
		'',
		`TIME = re.compile(r'${time}')`,
		`STATUS = re.compile(r'${status}')`,
		"NUMBER = re.compile(r'[0-9]+')",
		"METHODS = {'GET', 'POST', 'PUT', 'DELETE', 'PATCH'}",
		...normalize,
		'',
		"lines = sys.stdin.read().split('\\n')",
		header,
		'skipped = 0',
		'records = []',
		'for raw in lines[1:n + 1]:',
		'    f = raw.split()',
		`    if len(f) != 7 or not TIME.fullmatch(f[0]) or f[2] not in METHODS or not f[3].startswith('/') or not STATUS.fullmatch(f[4]) or not ${size} or not NUMBER.fullmatch(f[6]):`,
		'        skipped += 1',
		'        continue',
		`    records.append((f[0][:5], f[1], f[2], ${junior ? 'normalize(f[3])' : 'f[3]'}, int(f[4]), 0 if f[5] == '-' else int(f[5]), int(f[6])))`,
		...(body[cls] ?? []),
		"print('skipped', skipped)"
	].join('\n');
}

function applies(id: Variant, cls: string, junior: boolean): boolean {
	switch (id) {
		case 'range-unchecked':
		case 'dash-skipped':
			return true;
		case 'percentile-floor':
			return cls === 'p95-latency';
		case 'rate-truncated':
			return cls === 'error-rate';
		case 'no-tie-break':
			return cls === 'top-clients' || cls === 'top-paths';
		case 'requests-not-clients':
			return cls === 'unique-per-minute';
		case 'peak-tie-latest':
			return cls === 'peak-minute';
		case 'query-kept':
		case 'ids-kept':
			return junior;
		case 'right':
			return false;
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const cls = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== cls);
	const hidden = groups(rng, cls, others, junior);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(cls, junior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: hidden, checker: { kind: 'exact' } }
	});
	return {
		instance,
		reference: () => ({ kind: 'practice', source: referenceSource(cls, junior, 'right'), changeSource: null }),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, cls, junior) ? { kind: 'program' as const, source: referenceSource(cls, junior, id) } : null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
