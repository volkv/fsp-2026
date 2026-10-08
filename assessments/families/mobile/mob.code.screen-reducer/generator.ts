// Practice: the logic of a screen's view model as a reducer — an event log of user intents and asynchronous responses
// carrying the number of their request, and the rendered state after every event. The class is the screen: a search
// that drops outdated responses, a paged list with errors, retry and the end of the list, an optimistic toggle with a
// rollback, a form with validation and a guard against a double submit. Senior adds the combinations (a cache, a
// refresh that drops a load, acknowledgements out of order, a cancelled submit). The step «измени своё решение» adds
// the death of the process: only the fields SavedStateHandle keeps survive, requests in flight are lost.
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

const LANGUAGES = ['kotlin'] as const;
const CHANGE_WEIGHT = 0.3;
/** Rendered output of one test stays well below the 64 KB output limit of the sandbox. */
const OUTPUT_MAX = 50_000;

const descriptor = readDescriptor(import.meta.url);

const WRONG_IDS = [
	'stale-applied',
	'no-guard',
	'retry-anytime',
	'error-clears-data',
	'end-only-empty',
	'rollback-flip',
	'late-ack-overwrites',
	'weak-email'
] as const;
type WrongId = (typeof WRONG_IDS)[number];
/**
 * Solutions of the step the tests of the step must expose: `restore-noop` changes nothing on `restore`; `restore-keeps`
 * restores the state but lets the requests sent before `restore` still count.
 */
type Variant = 'right' | WrongId | 'restore-noop' | 'restore-keeps';

type Kind = 'search' | 'paging' | 'toggle' | 'form';

interface Options {
	senior: boolean;
	variant: Variant;
	/** The header numbers after N: page size (paging) or the number of items (toggle). */
	param: number;
}

/** A screen model: applies one event (its tokens) and renders the state. */
interface Screen {
	apply(ev: readonly string[]): void;
	render(): string;
	/** Requests sent and not answered yet, by number. */
	readonly open: Set<number>;
}

const num = (token: string | undefined): number => Number.parseInt(token ?? '', 10);

class Search implements Screen {
	query = '';
	items: string[] = [];
	status = 'idle';
	current = 0;
	queries: string[] = [];
	cache = new Map<string, string[]>();
	dead = 0;
	readonly open = new Set<number>();
	private readonly o: Options;
	constructor(o: Options) {
		this.o = o;
	}
	send(): void {
		this.queries.push(this.query);
		this.current = this.queries.length;
		this.open.add(this.current);
		this.status = 'loading';
	}
	apply(ev: readonly string[]): void {
		const v = this.o.variant;
		const stale = v === 'stale-applied';
		switch (ev[0]) {
			case 'type':
				this.query = ev[1] === '-' ? '' : (ev[1] ?? '');
				if (this.query.length < 2) {
					this.items = [];
					this.status = 'idle';
					this.current = 0;
				} else if (this.o.senior && this.cache.has(this.query)) {
					this.items = this.cache.get(this.query) ?? [];
					this.status = 'idle';
					this.current = 0;
				} else this.send();
				return;
			case 'ok': {
				const r = num(ev[1]);
				this.open.delete(r);
				const found = ev[2] === '-' ? [] : (ev[2] ?? '').split(',');
				if (this.o.senior && r > this.dead) this.cache.set(this.queries[r - 1] ?? '', found);
				if (r === this.current || stale) {
					this.items = found;
					this.status = 'idle';
					this.current = 0;
				}
				return;
			}
			case 'fail': {
				const r = num(ev[1]);
				this.open.delete(r);
				if (r === this.current || stale) {
					this.status = 'error';
					this.current = 0;
					if (v === 'error-clears-data') this.items = [];
				}
				return;
			}
			case 'retry':
				if (this.status === 'error' || v === 'retry-anytime') this.send();
				return;
			case 'restore':
				if (v === 'restore-noop') return;
				this.items = [];
				this.status = 'idle';
				this.current = 0;
				this.cache.clear();
				if (v !== 'restore-keeps') this.dead = this.queries.length;
				if (this.query.length >= 2) this.send();
				return;
		}
	}
	render(): string {
		return `${this.query || '-'} ${this.status} ${this.items.join(',') || '-'}`;
	}
}

class Paging implements Screen {
	loaded = 0;
	page = 1;
	status = 'loading';
	kinds: string[] = ['loading'];
	current = 1;
	failed = 'loading';
	readonly open = new Set<number>([1]);
	private readonly o: Options;
	constructor(o: Options) {
		this.o = o;
	}
	send(kind: string): void {
		this.status = kind;
		this.kinds.push(kind);
		this.current = this.kinds.length;
		this.open.add(this.current);
	}
	apply(ev: readonly string[]): void {
		const v = this.o.variant;
		const stale = v === 'stale-applied';
		switch (ev[0]) {
			case 'scroll':
				if (v === 'no-guard' ? this.status !== 'end' && this.status !== 'error' : this.status === 'idle')
					this.send('loading');
				return;
			case 'ok': {
				const [r, k] = [num(ev[1]), num(ev[2])];
				this.open.delete(r);
				if (r === this.current || stale) {
					if (this.kinds[r - 1] === 'refreshing') {
						this.loaded = k;
						this.page = 2;
					} else {
						this.loaded += k;
						this.page += 1;
					}
					this.status = (v === 'end-only-empty' ? k === 0 : k < this.o.param) ? 'end' : 'idle';
					this.current = 0;
				}
				return;
			}
			case 'fail': {
				const r = num(ev[1]);
				this.open.delete(r);
				if (r === this.current || stale) {
					this.failed = this.kinds[r - 1] ?? 'loading';
					this.status = 'error';
					this.current = 0;
				}
				return;
			}
			case 'retry':
				if (this.status === 'error' || v === 'retry-anytime') this.send(this.failed);
				return;
			case 'refresh':
				this.send('refreshing');
				return;
			case 'restore':
				if (v === 'restore-noop') return;
				this.loaded = 0;
				this.page = 1;
				this.failed = 'loading';
				this.send('loading');
				return;
		}
	}
	render(): string {
		return `${this.loaded} ${this.page} ${this.status}`;
	}
}

class Toggle implements Screen {
	shown: number[];
	confirmed: number[];
	applied: number[];
	latest: number[];
	reqs: [number, number][] = [];
	dead = 0;
	readonly open = new Set<number>();
	private readonly o: Options;
	constructor(o: Options) {
		this.o = o;
		this.shown = Array.from({ length: o.param }, () => 0);
		this.confirmed = [...this.shown];
		this.applied = [...this.shown];
		this.latest = [...this.shown];
	}
	apply(ev: readonly string[]): void {
		const v = this.o.variant;
		if (ev[0] === 'tap') {
			const i = num(ev[1]) - 1;
			this.shown[i] = 1 - (this.shown[i] ?? 0);
			this.reqs.push([i, this.shown[i] ?? 0]);
			this.latest[i] = this.reqs.length;
			this.open.add(this.reqs.length);
			return;
		}
		if (ev[0] === 'restore') {
			if (v === 'restore-noop') return;
			this.shown = [...this.confirmed];
			this.latest = this.latest.map(() => 0);
			if (v !== 'restore-keeps') this.dead = this.reqs.length;
			return;
		}
		const r = num(ev[1]);
		this.open.delete(r);
		if (r <= this.dead) return;
		const [i, value] = this.reqs[r - 1] ?? [0, 0];
		if (ev[0] === 'ok' && (!this.o.senior || r > (this.applied[i] ?? 0) || v === 'late-ack-overwrites')) {
			this.confirmed[i] = value;
			this.applied[i] = r;
		}
		if (r === this.latest[i] || v === 'stale-applied') this.latest[i] = 0;
		if (this.latest[i] === 0)
			this.shown[i] = v === 'rollback-flip' && ev[0] === 'fail' ? 1 - value : (this.confirmed[i] ?? 0);
	}
	render(): string {
		return `${this.shown.join('')} ${this.latest.filter((r) => r > 0).length}`;
	}
}

/** The validity of a form field. */
const validName = (name: string): boolean => name.length >= 2;
const validEmail = (email: string, weak: boolean): boolean => {
	if (weak) return email.includes('@');
	const at = email.indexOf('@');
	return email.split('@').length === 2 && at > 0 && at < email.length - 1;
};

class Form implements Screen {
	name = '';
	email = '';
	errors = new Set<string>();
	banner = 0;
	status = 'editing';
	current = 0;
	sent = 0;
	readonly open = new Set<number>();
	private readonly o: Options;
	constructor(o: Options) {
		this.o = o;
	}
	apply(ev: readonly string[]): void {
		const v = this.o.variant;
		switch (ev[0]) {
			case 'input': {
				if (this.status !== 'editing') return;
				const value = ev[2] === '-' ? '' : (ev[2] ?? '');
				if (ev[1] === 'name') this.name = value;
				else this.email = value;
				this.errors.delete(ev[1] ?? '');
				return;
			}
			case 'submit':
				if (this.status === 'editing' || (v === 'no-guard' && this.status === 'sending')) {
					this.errors = new Set();
					if (!validName(this.name)) this.errors.add('name');
					if (!validEmail(this.email, v === 'weak-email')) this.errors.add('email');
					if (this.errors.size === 0) {
						this.banner = 0;
						this.sent += 1;
						this.current = this.sent;
						this.open.add(this.current);
						this.status = 'sending';
					}
				}
				return;
			case 'cancel':
				if (this.status === 'sending') {
					this.status = 'editing';
					this.current = 0;
				}
				return;
			case 'restore':
				if (v === 'restore-noop') return;
				this.errors = new Set();
				this.banner = 0;
				this.current = 0;
				if (this.status !== 'sent') this.status = 'editing';
				return;
			default: {
				const r = num(ev[1]);
				this.open.delete(r);
				if (r !== this.current && v !== 'stale-applied') return;
				this.current = 0;
				if (ev[0] === 'ok') this.status = 'sent';
				else {
					this.status = 'editing';
					if (ev[2] === 'network') this.banner = 1;
					else this.errors = new Set(['email']);
				}
			}
		}
	}
	render(): string {
		const errors = ['name', 'email'].filter((f) => this.errors.has(f)).join(',') || '-';
		return `${this.status} ${errors} ${this.banner}`;
	}
}

function screen(kind: Kind, o: Options): Screen {
	switch (kind) {
		case 'search':
			return new Search(o);
		case 'paging':
			return new Paging(o);
		case 'toggle':
			return new Toggle(o);
		case 'form':
			return new Form(o);
	}
}

interface Input {
	param: number;
	events: string[];
}

/** The rendered state after every event; a variant other than `right` reproduces a wrong solution. */
function simulate(kind: Kind, input: Input, senior: boolean, variant: Variant = 'right'): string {
	const s = screen(kind, { senior, variant, param: input.param });
	const out: string[] = [];
	for (const line of input.events) {
		s.apply(line.split(' '));
		out.push(s.render());
	}
	return `${out.join('\n')}\n`;
}

function render(kind: Kind, input: Input): string {
	const head =
		kind === 'paging' || kind === 'toggle' ? `${input.events.length} ${input.param}` : `${input.events.length}`;
	return `${[head, ...input.events].join('\n')}\n`;
}

type GroupId = 'basic' | 'errors' | 'responses' | 'repeats' | 'failures';
const GROUP_IDS: GroupId[] = ['basic', 'errors', 'responses', 'repeats', 'failures'];
/**
 * The shape of one test's log: a group's own, or a large log (the last test of `failures`). `basic` and `errors` are
 * simple: every action waits for the answer to the request before it, so every wrong solution of the class passes.
 */
type Shape = GroupId | 'scale';
const SIMPLE: readonly GroupId[] = ['basic', 'errors'];

const QUERIES = [
	'ko',
	'co',
	'ro',
	'kot',
	'koin',
	'kotlin',
	'room',
	'retro',
	'retrofit',
	'coil',
	'compose',
	'hilt',
	'ktor'
];
const SHORT = ['-', 'k', 'c', 'r'];
const LIBS = ['retrofit', 'room', 'koin', 'hilt', 'coil', 'ktor', 'okhttp', 'moshi', 'glide', 'dagger', 'paging'];
const NAMES_OK = ['ivan', 'olga', 'yu', 'li', 'anna', 'petr', 'ksenia'];
const NAMES_BAD = ['-', 'a', 'y'];
const EMAILS_OK = ['ivan@mail.ru', 'olga@ya.ru', 'a@b', 'yu@corp.dev', 'li@x'];
const EMAILS_BAD = ['-', 'ivan', 'ivan@', '@mail.ru', 'a@b@c', 'olga.ya.ru'];

type Weights = Record<string, number>;

function choose(rng: Rng, weights: Weights): string {
	const entries = Object.entries(weights).filter(([, w]) => w > 0);
	let x = rng.next() * entries.reduce((s, [, w]) => s + w, 0);
	for (const [key, w] of entries) {
		x -= w;
		if (x < 0) return key;
	}
	return entries[entries.length - 1]?.[0] ?? '';
}

/** A response to one of the open requests; `older` prefers a request other than the newest one. */
function pickOpen(rng: Rng, open: Set<number>, older: boolean): number {
	const ids = [...open].sort((a, b) => a - b);
	const newest = ids[ids.length - 1] ?? 0;
	return older && ids.length > 1 && rng.bool(0.7) ? rng.pick(ids.slice(0, -1)) : rng.bool(0.6) ? newest : rng.pick(ids);
}

/** The next event of the log for the state of the right model. */
function nextEvent(
	rng: Rng,
	kind: Kind,
	s: Screen,
	param: number,
	group: Exclude<Shape, 'basic' | 'errors'>,
	senior: boolean,
	step: boolean,
	finishing: boolean
): string {
	const open = s.open;
	const respond = open.size > 0;
	const restore = step ? (group === 'scale' ? 0.3 : 0.8) : 0;
	if (kind === 'search') {
		const m = s as Search;
		const w: Weights = {
			responses: { type: 4, ok: 5, fail: 2, retry: 1 },
			repeats: { type: 2, ok: 2, fail: 3, retry: 4 },
			failures: { type: 3, ok: 2, fail: 4, retry: 3 },
			scale: { type: 4, ok: 4, fail: 2, retry: 1 }
		}[group];
		const e = choose(rng, { ...w, ok: respond ? (w.ok ?? 0) : 0, fail: respond ? (w.fail ?? 0) : 0, restore });
		if (e === 'type') {
			const typed = m.queries;
			const q = rng.bool(0.2)
				? rng.pick(SHORT)
				: senior && typed.length > 0 && rng.bool(0.35)
					? rng.pick(typed)
					: rng.pick(QUERIES);
			return `type ${q}`;
		}
		if (e === 'ok') {
			const items = rng.sample(LIBS, rng.int(0, group === 'scale' ? 2 : 3));
			return `ok ${pickOpen(rng, open, group === 'responses')} ${items.join(',') || '-'}`;
		}
		if (e === 'fail') return `fail ${pickOpen(rng, open, group === 'responses')}`;
		return e;
	}
	if (kind === 'paging') {
		const size = param;
		const w: Weights = {
			responses: { scroll: 3, ok: 5, fail: 1, retry: 1, refresh: 2 },
			repeats: { scroll: 6, ok: 2, fail: 2, retry: 3, refresh: 1 },
			failures: { scroll: 2, ok: 2, fail: 4, retry: 3, refresh: 1 },
			scale: { scroll: 4, ok: 4, fail: 2, retry: 2, refresh: 0.5 }
		}[group];
		const e = choose(rng, {
			...w,
			ok: respond ? (w.ok ?? 0) : 0,
			fail: respond ? (w.fail ?? 0) : 0,
			refresh: senior ? (w.refresh ?? 0) : 0,
			restore
		});
		if (e === 'ok') {
			const end = !finishing ? 0 : group === 'scale' ? 0.2 : group === 'responses' ? 0.3 : 0.12;
			return `ok ${pickOpen(rng, open, group === 'responses')} ${rng.bool(end) ? rng.int(0, size - 1) : size}`;
		}
		if (e === 'fail') return `fail ${pickOpen(rng, open, group === 'responses')}`;
		return e;
	}
	if (kind === 'toggle') {
		const m = s as Toggle;
		const items = m.shown.length;
		const w: Weights = {
			responses: { tap: 4, ok: 3, fail: 2 },
			repeats: { tap: 6, ok: 2, fail: 2 },
			failures: { tap: 3, ok: 1, fail: 4 },
			scale: { tap: 4, ok: 3, fail: 2 }
		}[group];
		const e = choose(rng, { ...w, ok: respond ? (w.ok ?? 0) : 0, fail: respond ? (w.fail ?? 0) : 0, restore });
		if (e === 'tap') {
			const hot = group === 'repeats' || group === 'responses' ? Math.min(items, 2) : items;
			return `tap ${rng.int(1, hot)}`;
		}
		if (e === 'restore') return e;
		// Middle: the responses of one item come in the order of its requests.
		const ids = [...open].sort((a, b) => a - b);
		const r = senior
			? pickOpen(rng, open, group === 'responses')
			: (() => {
					const item = m.reqs[rng.pick(ids) - 1]?.[0];
					return ids.find((id) => m.reqs[id - 1]?.[0] === item) ?? 0;
				})();
		return `${e} ${r}`;
	}
	const w: Weights = {
		responses: { name: 1, email: 1, submit: 3, ok: 1.2, fail: 3, cancel: 3 },
		repeats: { name: 1, email: 1, submit: 6, ok: 0.6, fail: 2, cancel: 1 },
		failures: { name: 3, email: 3, submit: 3, ok: 0.3, fail: 3, cancel: 1 },
		scale: { name: 3, email: 3, submit: 3, ok: 0.3, fail: 3, cancel: 1 }
	}[group];
	const e = choose(rng, {
		...w,
		ok: respond && finishing ? (w.ok ?? 0) : 0,
		fail: respond ? (w.fail ?? 0) : 0,
		cancel: senior ? (w.cancel ?? 0) : 0,
		restore
	});
	if (e === 'name') return `input name ${rng.pick(rng.bool(0.6) ? NAMES_OK : NAMES_BAD)}`;
	if (e === 'email') return `input email ${rng.pick(rng.bool(0.55) ? EMAILS_OK : EMAILS_BAD)}`;
	if (e === 'ok') return `ok ${pickOpen(rng, open, group === 'responses')}`;
	if (e === 'fail')
		return `fail ${pickOpen(rng, open, group === 'responses')} ${rng.bool(0.6) ? 'network' : 'email_taken'}`;
	return e;
}

/**
 * The next event of a simple log: the open request with the highest number gets its answer before any action; an
 * action never repeats a request in flight (`retry` only after an error, `scroll` only in `idle`, no `cancel`).
 * `errors` adds failures; a search fails only with an empty list, a page ends only empty, an email is either valid or
 * has no `@`. In the step `restore` may come at any moment.
 */
function sequentialEvent(
	rng: Rng,
	kind: Kind,
	s: Screen,
	param: number,
	errors: boolean,
	senior: boolean,
	step: boolean,
	finishing: boolean
): string {
	if (step && rng.bool(0.12)) return 'restore';
	const open = [...s.open].sort((a, b) => a - b);
	const r = open.at(-1);
	const fail = errors && rng.bool(0.4);
	if (kind === 'search') {
		const m = s as Search;
		if (r !== undefined) {
			if (fail && m.items.length === 0) return `fail ${r}`;
			return `ok ${r} ${rng.sample(LIBS, rng.int(0, 3)).join(',') || '-'}`;
		}
		if (m.status === 'error' && rng.bool(0.6)) return 'retry';
		const q = rng.bool(errors ? 0.35 : 0.2)
			? rng.pick(SHORT)
			: senior && m.queries.length > 0 && rng.bool(0.35)
				? rng.pick(m.queries)
				: rng.pick(QUERIES);
		return `type ${q}`;
	}
	if (kind === 'paging') {
		const m = s as Paging;
		if (r !== undefined) {
			if (fail) return `fail ${r}`;
			return `ok ${r} ${finishing && rng.bool(0.15) ? 0 : param}`;
		}
		if (senior && rng.bool(0.2)) return 'refresh';
		return m.status === 'error' ? 'retry' : 'scroll';
	}
	if (kind === 'toggle') {
		if (r !== undefined) return `${fail ? 'fail' : 'ok'} ${r}`;
		return `tap ${rng.int(1, (s as Toggle).shown.length)}`;
	}
	if (r !== undefined)
		return fail || (errors && !finishing) ? `fail ${r} ${rng.bool(0.6) ? 'network' : 'email_taken'}` : `ok ${r}`;
	const e = choose(rng, { name: 2, email: 2, submit: 3 });
	if (e === 'name') return `input name ${rng.pick(rng.bool(0.6) ? NAMES_OK : NAMES_BAD)}`;
	if (e === 'email')
		return `input email ${rng.pick(rng.bool(0.55) ? EMAILS_OK : EMAILS_BAD.filter((x) => !x.includes('@')))}`;
	return e;
}

function makeInput(rng: Rng, kind: Kind, shape: Shape, senior: boolean, step: boolean): Input {
	const param = kind === 'paging' ? rng.int(2, 10) : kind === 'toggle' ? rng.int(3, 6) : 0;
	const simple = shape === 'basic' || shape === 'errors';
	const length = shape === 'scale' ? rng.int(900, 1100) : simple ? rng.int(10, 18) : rng.int(12, 24);
	const s = screen(kind, { senior, variant: 'right', param });
	const events: string[] = [];
	let tail = -1;
	while (events.length < length && tail !== 0) {
		// The end of the list and a sent form finish the screen: not before the last events of a large log, not in the
		// first events of a small one.
		const finishing = shape === 'scale' ? events.length >= length - 20 : events.length >= 6;
		const ev = simple
			? sequentialEvent(rng, kind, s, param, shape === 'errors', senior, step, finishing)
			: nextEvent(rng, kind, s, param, shape, senior, step, finishing);
		events.push(ev);
		s.apply(ev.split(' '));
		// A finished screen (the list ended in Middle, the form is sent) gets a few more events, then the log ends.
		const done =
			(kind === 'paging' && !senior && (s as Paging).status === 'end') ||
			(kind === 'form' && (s as Form).status === 'sent');
		if (done && tail < 0) tail = rng.int(1, 3);
		else if (tail > 0) tail -= 1;
	}
	return { param, events };
}

/** The wrong solutions a group must expose on every test of the class. */
function traps(kind: Kind, group: GroupId, senior: boolean): WrongId[] {
	const list: Record<Kind, Partial<Record<GroupId, WrongId[]>>> = {
		search: { responses: ['stale-applied'], repeats: ['retry-anytime'], failures: ['error-clears-data'] },
		paging: {
			responses: senior ? ['end-only-empty', 'stale-applied'] : ['end-only-empty'],
			repeats: ['no-guard', 'retry-anytime']
		},
		toggle: {
			responses: senior ? ['stale-applied', 'late-ack-overwrites'] : ['stale-applied'],
			failures: ['rollback-flip']
		},
		form: { responses: senior ? ['stale-applied'] : [], repeats: ['no-guard'], failures: ['weak-email'] }
	};
	return list[kind][group] ?? [];
}

function applies(id: WrongId, kind: Kind, senior: boolean): boolean {
	return GROUP_IDS.some((g) => traps(kind, g, senior).includes(id));
}

function groups(rng: Rng, kind: Kind, senior: boolean, step: boolean): HiddenTestGroup[] {
	const wrongs = WRONG_IDS.filter((id) => applies(id, kind, senior));
	return GROUP_IDS.map((id) => {
		const shapes: Shape[] = id === 'failures' ? ['failures', 'failures', 'failures', 'scale'] : [id, id, id, id];
		const simple = SIMPLE.includes(id);
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < shapes.length; attempt += 1) {
			if (attempt > 2000) throw new Error(`${descriptor.key}: no ${id} test for ${kind}`);
			const input = makeInput(rng, kind, shapes[tests.length] as Shape, senior, step);
			const expected = simulate(kind, input, senior);
			if (expected.length > OUTPUT_MAX) continue;
			// A simple test is passed by every wrong solution of the class (in the step — with `restore` done right).
			if (simple && wrongs.some((v) => simulate(kind, input, senior, v) !== expected)) continue;
			if (step) {
				// The step's tests expose a solution that ignores `restore`; the others also one that applies any response
				// and one that keeps the requests sent before `restore`.
				if (!input.events.includes('restore')) continue;
				const naive: Variant[] = simple ? ['restore-noop'] : ['restore-noop', 'stale-applied'];
				if (!simple && (kind === 'toggle' || (kind === 'search' && senior))) naive.push('restore-keeps');
				if (naive.some((v) => simulate(kind, input, senior, v) === expected)) continue;
			} else if (traps(kind, id, senior).some((v) => simulate(kind, input, senior, v) === expected)) continue;
			tests.push({ stdin: render(kind, input), expected });
		}
		return { id, tests };
	});
}

const KINDS: Record<string, Kind> = { search: 'search', paging: 'paging', 'optimistic-like': 'toggle', form: 'form' };

const RESPONSES =
	'Запросы экрана нумеруются по порядку отправки, начиная с 1. Ответ (`ok` или `fail`) приходит только на уже отправленный запрос и не больше одного раза; на некоторые запросы ответ не приходит вовсе.';

function rules(kind: Kind, senior: boolean): string[] {
	switch (kind) {
		case 'search':
			return [
				'Экран поиска библиотек: пользователь вводит текст, экран отправляет запрос на сервер, ответы приходят асинхронно и могут опаздывать.',
				'',
				'## Вход',
				'',
				'В первой строке — `N` (1 ≤ N ≤ 2000), далее `N` строк событий:',
				'',
				'- `type <q>` — пользователь изменил текст поиска на `q` (строчные латинские буквы; `-` — пустая строка);',
				'- `ok <r> <items>` — успешный ответ на запрос `r`: названия через запятую без пробелов, `-` — пустой результат;',
				'- `fail <r>` — запрос `r` завершился ошибкой;',
				'- `retry` — нажата кнопка «Повторить».',
				'',
				RESPONSES,
				'',
				'## Правила',
				'',
				`Состояние — текст \`q\`, список результатов и статус \`idle\`, \`loading\` или \`error\`; в начале \`q\` пуст, список пуст${senior ? ', кэш пуст' : ''}, статус \`idle\`.`,
				'',
				`- \`type\`: если в \`q\` меньше 2 символов — список очищается, статус \`idle\`, запрос не отправляется.${senior ? ' Иначе, если в кэше есть результат для `q`, — список становится им, статус `idle`, запрос не отправляется.' : ''} Иначе отправляется новый запрос с текстом \`q\`, статус \`loading\`; список не меняется до ответа.`,
				'- **Актуальный** запрос — последний отправленный, если после его отправки не было события `type` и на него ещё не пришёл ответ. Ответ на неактуальный запрос экран не меняет.',
				'- `ok` на актуальный запрос: список становится `items`, статус `idle`.',
				'- `fail` на актуальный запрос: статус `error`, список не меняется.',
				'- `retry`: только в статусе `error` отправляет новый запрос с текущим `q` (статус `loading`); в других статусах ничего не делает.',
				...(senior
					? [
							'- Кэш: **любой** успешный ответ, актуальный или нет, сохраняется в кэш для текста своего запроса (новый ответ для того же текста заменяет прежний). Ошибки в кэш не попадают.'
						]
					: []),
				'',
				'## Выход',
				'',
				'`N` строк — состояние после каждого события: `<q> <статус> <список>`, где пустой `q` печатается как `-`, список — названия через запятую или `-`.'
			];
		case 'paging':
			return [
				'Лента с постраничной загрузкой: страница — `S` элементов. При открытии экран уже отправил запрос 1 за страницей 1.',
				'',
				'## Вход',
				'',
				'В первой строке — `N S` (1 ≤ N ≤ 2000, 2 ≤ S ≤ 10), далее `N` строк событий:',
				'',
				'- `scroll` — пользователь долистал до конца загруженного;',
				'- `ok <r> <k>` — ответ на запрос `r`: страница из `k` элементов (0 ≤ k ≤ S);',
				'- `fail <r>` — запрос `r` завершился ошибкой;',
				`- \`retry\` — нажата кнопка «Повторить»${senior ? ';' : '.'}`,
				...(senior ? ['- `refresh` — пользователь потянул список вниз, «обновить».'] : []),
				'',
				RESPONSES,
				'',
				'## Правила',
				'',
				`Состояние — число загруженных элементов \`loaded\`, номер следующей страницы \`page\` и статус \`loading\`, \`idle\`, \`error\`${senior ? ', `refreshing`' : ''} или \`end\`; в начале \`0 1 loading\`, запрос 1 актуален.`,
				'',
				'- **Актуальный** запрос — последний отправленный, пока на него не пришёл ответ. Ответ на неактуальный запрос ничего не меняет.',
				'- `scroll`: только в статусе `idle` отправляет запрос за страницей `page` (статус `loading`); в остальных статусах ничего не делает.',
				`- \`ok\` на актуальный запрос${senior ? ' за подгрузкой' : ''}: \`loaded\` увеличивается на \`k\`, \`page\` — на 1; статус \`end\`, если \`k < S\`, иначе \`idle\`.`,
				'- `fail` на актуальный запрос: статус `error`.',
				`- \`retry\`: только в статусе \`error\` повторяет неудавшийся запрос новым запросом${senior ? ': после ошибки подгрузки — за той же страницей `page` (статус `loading`), после ошибки обновления — обновление (статус `refreshing`)' : ' за той же страницей `page` (статус `loading`)'}; в других статусах ничего не делает.`,
				...(senior
					? [
							'- `refresh`: в любом статусе отправляет запрос за страницей 1, статус `refreshing`; прежний актуальный запрос перестаёт быть актуальным.',
							'- `ok` на актуальный запрос обновления: `loaded` становится `k`, `page` — 2; статус `end`, если `k < S`, иначе `idle`.'
						]
					: []),
				'',
				'## Выход',
				'',
				'`N` строк — состояние после каждого события: `<loaded> <page> <статус>`.'
			];
		case 'toggle':
			return [
				'Лента из `M` постов с кнопкой «нравится». Нажатие сразу меняет отметку на экране (оптимистично) и отправляет запрос с новым значением. Сервер применяет запросы в порядке их отправки и отвечает `ok` (применён) или `fail` (отклонён и не применён).',
				'',
				'## Вход',
				'',
				'В первой строке — `N M` (1 ≤ N ≤ 2000, 2 ≤ M ≤ 8), далее `N` строк событий:',
				'',
				'- `tap <i>` — нажата кнопка у поста `i` (1 ≤ i ≤ M);',
				'- `ok <r>` — сервер применил запрос `r`;',
				'- `fail <r>` — сервер отклонил запрос `r`.',
				'',
				RESPONSES,
				senior
					? 'Ответы приходят **в любом порядке**, в том числе ответы на запросы одного поста.'
					: 'Ответы на запросы одного поста приходят в порядке их отправки; ответы разных постов перемешаны.',
				'',
				'## Правила',
				'',
				'У каждого поста — показанное значение, подтверждённое значение (последнее, что применил сервер) и последний отправленный по нему запрос, если ответа на него ещё нет («ожидающий»). В начале все значения 0, ожидающих нет.',
				'',
				'- `tap i`: показанное значение поста меняется на противоположное, отправляется запрос с новым значением, он становится ожидающим запросом поста.',
				`- \`ok r\` (пост \`i\`, значение \`v\`): подтверждённое значение поста становится \`v\`${senior ? ' — но только если `r` больше номера последнего уже применённого запроса этого поста: подтверждение более раннего запроса, пришедшее позже, состояние сервера не откатывает' : ''}. Если \`r\` — ожидающий запрос поста, ожидающего больше нет.`,
				'- `fail r`: если `r` — ожидающий запрос поста, ожидающего больше нет; ответ на более ранний запрос поста ничего не меняет.',
				'- После каждого ответа: если у поста нет ожидающего запроса, его показанное значение становится подтверждённым.',
				'',
				'## Выход',
				'',
				'`N` строк — состояние после каждого события: `<значения> <ожидают>`, где значения — показанные значения постов 1…M подряд (строка из `0` и `1`), ожидают — число постов с ожидающим запросом.'
			];
		case 'form':
			return [
				'Форма регистрации: поля `name` и `email`, кнопка «Отправить».',
				'',
				'## Вход',
				'',
				'В первой строке — `N` (1 ≤ N ≤ 2000), далее `N` строк событий:',
				'',
				'- `input <поле> <значение>` — пользователь изменил поле `name` или `email`; значение — латинские буквы, цифры, `@` и `.`; `-` — пустая строка;',
				'- `submit` — нажата кнопка «Отправить»;',
				'- `ok <r>` — запрос `r` выполнен, пользователь зарегистрирован;',
				`- \`fail <r> <причина>\` — запрос \`r\` отклонён: причина \`network\` (сеть) или \`email_taken\` (адрес занят)${senior ? ';' : '.'}`,
				...(senior ? ['- `cancel` — пользователь нажал «Отменить» во время отправки.'] : []),
				'',
				RESPONSES,
				'',
				'## Правила',
				'',
				'Состояние — значения полей (в начале пустые), множество полей с ошибкой, баннер «Нет сети» (`0`/`1`) и статус `editing`, `sending` или `sent`; в начале ошибок нет, баннер 0, статус `editing`.',
				'',
				'- `input`: только в статусе `editing` — поле получает значение, ошибка этого поля снимается; в `sending` и `sent` поля заблокированы, событие ничего не делает.',
				'- `submit`: только в статусе `editing` (повторное нажатие во время отправки и после неё ничего не делает). Проверка: `name` — не короче 2 символов; `email` — ровно один `@`, и до и после него есть хотя бы по одному символу. Множество ошибок становится множеством неверных полей; если ошибок нет — баннер 0, отправляется запрос, статус `sending`.',
				`- **Актуальный** запрос — последний отправленный, пока на него не пришёл ответ${senior ? ' и пока его не отменили' : ''}. Ответ на неактуальный запрос ничего не меняет.`,
				'- `ok` на актуальный запрос: статус `sent`.',
				'- `fail` на актуальный запрос: статус `editing`; `network` — баннер 1; `email_taken` — множество ошибок становится `{email}`.',
				...(senior
					? [
							'- `cancel`: только в статусе `sending` — статус `editing`, запрос перестаёт быть актуальным; в других статусах ничего не делает.'
						]
					: []),
				'',
				'## Выход',
				'',
				'`N` строк — состояние после каждого события: `<статус> <ошибки> <баннер>`, где ошибки — поля с ошибкой через запятую в порядке `name,email` или `-`.'
			];
	}
}

function statement(kind: Kind, senior: boolean): string {
	return [
		'Напишите на Kotlin (`fun main()`, чтение стандартного ввода) логику модели представления экрана как редьюсер: по журналу событий — намерений пользователя и асинхронных ответов сервера с номером запроса — напечатайте отрисованное состояние экрана после каждого события.',
		'',
		...rules(kind, senior),
		'',
		'Заготовка разбора ввода и вывода (можно взять как есть):',
		'',
		'```kotlin',
		...skeleton(kind, senior),
		'```',
		'',
		'Скрытые тесты — пять групп. Первые две — последовательный сценарий: на каждый запрос ответ приходит раньше следующего действия пользователя, кнопки не нажимаются во время запроса; в первой без ошибок, во второй с ошибками и повтором. Остальные: опоздавшие и устаревшие ответы; повторные действия; ошибки и повтор, последний тест группы — большой журнал (около тысячи событий). Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

/** A Kotlin skeleton that reads the events of the screen and prints a line per event: the candidate fills in the logic. */
function skeleton(kind: Kind, senior: boolean): string[] {
	const head: Record<Kind, string> = {
		search: '    val n = readln().trim().toInt()',
		paging: '    val (n, s) = readln().trim().split(" ").map { it.toInt() }',
		toggle: '    val (n, m) = readln().trim().split(" ").map { it.toInt() }',
		form: '    val n = readln().trim().toInt()'
	};
	const branches: Record<Kind, string[]> = {
		search: [
			'            "type" -> { val q = if (ev[1] == "-") "" else ev[1] }',
			'            "ok" -> {',
			'                val r = ev[1].toInt()',
			'                val items = if (ev[2] == "-") emptyList<String>() else ev[2].split(",")',
			'            }',
			'            "fail" -> { val r = ev[1].toInt() }',
			'            "retry" -> {}'
		],
		paging: [
			'            "scroll" -> {}',
			'            "ok" -> { val r = ev[1].toInt(); val k = ev[2].toInt() }',
			'            "fail" -> { val r = ev[1].toInt() }',
			'            "retry" -> {}',
			...(senior ? ['            "refresh" -> {}'] : [])
		],
		toggle: [
			'            "tap" -> { val i = ev[1].toInt() }',
			'            "ok" -> { val r = ev[1].toInt() }',
			'            "fail" -> { val r = ev[1].toInt() }'
		],
		form: [
			'            "input" -> { val field = ev[1]; val value = if (ev[2] == "-") "" else ev[2] }',
			'            "submit" -> {}',
			'            "ok" -> { val r = ev[1].toInt() }',
			'            "fail" -> { val r = ev[1].toInt(); val reason = ev[2] }',
			...(senior ? ['            "cancel" -> {}'] : [])
		]
	};
	return [
		'fun main() {',
		head[kind],
		'    val out = StringBuilder()',
		'    repeat(n) {',
		'        val ev = readln().trim().split(" ")',
		'        when (ev[0]) {',
		...branches[kind],
		'        }',
		'        out.append("состояние после события").append(\'\\n\')',
		'    }',
		'    print(out)',
		'}'
	];
}

const SAVED: Record<Kind, (senior: boolean) => string> = {
	search: (senior) =>
		`Сохраняется только текст \`q\`. После восстановления список пуст${senior ? ', кэш пуст' : ''}; если в \`q\` не меньше 2 символов, экран сразу отправляет новый запрос с ним (статус \`loading\`), иначе статус \`idle\`.`,
	paging: (senior) =>
		`Не сохраняется ничего: экран открывается заново — \`loaded\` 0, \`page\` 1, и сразу отправляется новый запрос за страницей 1 (статус \`loading\`${senior ? '; повтор после ошибки снова повторяет подгрузку' : ''}).`,
	toggle: () =>
		'Сохраняются только подтверждённые значения постов. После восстановления показанные значения равны подтверждённым, ожидающих запросов нет.',
	form: () =>
		'Сохраняются значения полей и то, что форма уже отправлена (статус `sent` остаётся `sent`). Остальное — как в начале: статус `editing`, ошибок нет, баннер 0.'
};

function changeStatement(kind: Kind, senior: boolean): string {
	return [
		'**Новое условие: смерть процесса.** В журнале появляется событие `restore`: система убила процесс приложения в фоне, пользователь вернулся, и модель представления создана заново из `SavedStateHandle`.',
		'',
		SAVED[kind](senior),
		'',
		`Запросы, отправленные до \`restore\`, потеряны вместе с процессом: ответы на них ещё могут прийти и ничего не должны менять${kind === 'search' && senior ? ' — ни экран, ни кэш' : ''}. Нумерация запросов продолжается (новый запрос получает следующий номер). После \`restore\` печатается восстановленное состояние; остальные правила и формат вывода прежние. Измените решение и отправьте его снова.`
	].join('\n');
}

/** The reference of the search screen in Python; a variant other than `right` is a wrong solution. */
function searchSource(senior: boolean, step: boolean, v: Variant): string {
	return [
		'import sys',
		'',
		"data = sys.stdin.read().split('\\n')",
		'n = int(data[0])',
		"query, items, status, current = '', [], 'idle', 0",
		'queries = []',
		...(senior ? ['cache = {}'] : []),
		...(senior && step ? ['dead = 0'] : []),
		'out = []',
		'',
		'',
		'def send():',
		'    global current, status',
		'    queries.append(query)',
		'    current = len(queries)',
		"    status = 'loading'",
		'',
		'',
		'for line in data[1:n + 1]:',
		'    ev = line.split()',
		"    if ev[0] == 'type':",
		"        query = '' if ev[1] == '-' else ev[1]",
		'        if len(query) < 2:',
		"            items, status, current = [], 'idle', 0",
		...(senior ? ['        elif query in cache:', "            items, status, current = cache[query], 'idle', 0"] : []),
		'        else:',
		'            send()',
		"    elif ev[0] == 'ok':",
		'        r = int(ev[1])',
		"        found = [] if ev[2] == '-' else ev[2].split(',')",
		...(senior
			? step
				? ['        if r > dead:', '            cache[queries[r - 1]] = found']
				: ['        cache[queries[r - 1]] = found']
			: []),
		v === 'stale-applied' ? '        if r:' : '        if r == current:',
		"            items, status, current = found, 'idle', 0",
		"    elif ev[0] == 'fail':",
		v === 'stale-applied' ? '        if ev[1]:' : '        if int(ev[1]) == current:',
		v === 'error-clears-data'
			? "            items, status, current = [], 'error', 0"
			: "            status, current = 'error', 0",
		"    elif ev[0] == 'retry':",
		...(v === 'retry-anytime' ? ['        send()'] : ["        if status == 'error':", '            send()']),
		...(step
			? [
					"    elif ev[0] == 'restore':",
					senior
						? "        items, status, current, cache = [], 'idle', 0, {}"
						: "        items, status, current = [], 'idle', 0",
					...(senior ? ['        dead = len(queries)'] : []),
					'        if len(query) >= 2:',
					'            send()'
				]
			: []),
		"    out.append(f\"{query or '-'} {status} {','.join(items) or '-'}\")",
		"print('\\n'.join(out))"
	].join('\n');
}

function pagingSource(senior: boolean, step: boolean, v: Variant): string {
	return [
		'import sys',
		'',
		"data = sys.stdin.read().split('\\n')",
		'n, size = map(int, data[0].split())',
		"loaded, page, status, failed = 0, 1, 'loading', 'loading'",
		"kinds = ['loading']",
		'current = 1',
		'out = []',
		'',
		'',
		'def send(kind):',
		'    global status, current',
		'    status = kind',
		'    kinds.append(kind)',
		'    current = len(kinds)',
		'',
		'',
		'for line in data[1:n + 1]:',
		'    ev = line.split()',
		"    if ev[0] == 'scroll':",
		v === 'no-guard' ? "        if status not in ('end', 'error'):" : "        if status == 'idle':",
		"            send('loading')",
		"    elif ev[0] == 'ok':",
		'        r, k = int(ev[1]), int(ev[2])',
		v === 'stale-applied' ? '        if r:' : '        if r == current:',
		...(senior
			? [
					"            if kinds[r - 1] == 'refreshing':",
					'                loaded, page = k, 2',
					'            else:',
					'                loaded, page = loaded + k, page + 1'
				]
			: ['            loaded, page = loaded + k, page + 1']),
		v === 'end-only-empty'
			? "            status = 'end' if k == 0 else 'idle'"
			: "            status = 'end' if k < size else 'idle'",
		'            current = 0',
		"    elif ev[0] == 'fail':",
		'        r = int(ev[1])',
		v === 'stale-applied' ? '        if r:' : '        if r == current:',
		"            failed, status, current = kinds[r - 1], 'error', 0",
		"    elif ev[0] == 'retry':",
		...(v === 'retry-anytime'
			? ['        send(failed)']
			: ["        if status == 'error':", '            send(failed)']),
		...(senior ? ["    elif ev[0] == 'refresh':", "        send('refreshing')"] : []),
		...(step
			? ["    elif ev[0] == 'restore':", "        loaded, page, failed = 0, 1, 'loading'", "        send('loading')"]
			: []),
		"    out.append(f'{loaded} {page} {status}')",
		"print('\\n'.join(out))"
	].join('\n');
}

function toggleSource(senior: boolean, step: boolean, v: Variant): string {
	const ack = senior && v !== 'late-ack-overwrites';
	return [
		'import sys',
		'',
		"data = sys.stdin.read().split('\\n')",
		'n, m = map(int, data[0].split())',
		'shown = [0] * m',
		'confirmed = [0] * m',
		...(ack ? ['applied = [0] * m'] : []),
		'latest = [0] * m',
		'reqs = []',
		...(step ? ['dead = 0'] : []),
		'out = []',
		'for line in data[1:n + 1]:',
		'    ev = line.split()',
		"    if ev[0] == 'tap':",
		'        i = int(ev[1]) - 1',
		'        shown[i] = 1 - shown[i]',
		'        reqs.append((i, shown[i]))',
		'        latest[i] = len(reqs)',
		...(step ? ["    elif ev[0] == 'restore':", '        shown, latest, dead = confirmed[:], [0] * m, len(reqs)'] : []),
		step ? '    elif int(ev[1]) > dead:' : '    else:',
		'        r = int(ev[1])',
		'        i, value = reqs[r - 1]',
		...(ack
			? ["        if ev[0] == 'ok' and r > applied[i]:", '            confirmed[i], applied[i] = value, r']
			: ["        if ev[0] == 'ok':", '            confirmed[i] = value']),
		v === 'stale-applied' ? '        if r:' : '        if r == latest[i]:',
		'            latest[i] = 0',
		'        if latest[i] == 0:',
		v === 'rollback-flip'
			? "            shown[i] = confirmed[i] if ev[0] == 'ok' else 1 - value"
			: '            shown[i] = confirmed[i]',
		"    out.append(''.join(map(str, shown)) + ' ' + str(m - latest.count(0)))",
		"print('\\n'.join(out))"
	].join('\n');
}

function formSource(senior: boolean, step: boolean, v: Variant): string {
	return [
		'import sys',
		'',
		"data = sys.stdin.read().split('\\n')",
		'n = int(data[0])',
		"name, email, errors, banner, status, current, sent = '', '', set(), 0, 'editing', 0, 0",
		'out = []',
		'for line in data[1:n + 1]:',
		'    ev = line.split()',
		"    if ev[0] == 'input':",
		"        if status == 'editing':",
		"            value = '' if ev[2] == '-' else ev[2]",
		"            if ev[1] == 'name':",
		'                name = value',
		'            else:',
		'                email = value',
		'            errors.discard(ev[1])',
		"    elif ev[0] == 'submit':",
		v === 'no-guard' ? "        if status != 'sent':" : "        if status == 'editing':",
		'            errors = set()',
		'            if len(name) < 2:',
		"                errors.add('name')",
		...(v === 'weak-email'
			? ["            if '@' not in email:"]
			: [
					"            at = email.find('@')",
					"            if email.count('@') != 1 or at == 0 or at == len(email) - 1:"
				]),
		"                errors.add('email')",
		'            if not errors:',
		"                banner, sent, status = 0, sent + 1, 'sending'",
		'                current = sent',
		...(senior
			? ["    elif ev[0] == 'cancel':", "        if status == 'sending':", "            status, current = 'editing', 0"]
			: []),
		...(step
			? [
					"    elif ev[0] == 'restore':",
					'        errors, banner, current = set(), 0, 0',
					"        if status != 'sent':",
					"            status = 'editing'"
				]
			: []),
		v === 'stale-applied' ? '    elif ev[1]:' : '    elif int(ev[1]) == current:',
		'        current = 0',
		"        if ev[0] == 'ok':",
		"            status = 'sent'",
		'        else:',
		"            status = 'editing'",
		"            if ev[2] == 'network':",
		'                banner = 1',
		'            else:',
		"                errors = {'email'}",
		"    shown = ','.join(f for f in ('name', 'email') if f in errors) or '-'",
		"    out.append(f'{status} {shown} {banner}')",
		"print('\\n'.join(out))"
	].join('\n');
}

function referenceSource(kind: Kind, senior: boolean, step: boolean, v: Variant): string {
	switch (kind) {
		case 'search':
			return searchSource(senior, step, v);
		case 'paging':
			return pagingSource(senior, step, v);
		case 'toggle':
			return toggleSource(senior, step, v);
		case 'form':
			return formSource(senior, step, v);
	}
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const kind = KINDS[input.classId];
	if (!kind) throw new Error(`${descriptor.key}: unknown class ${input.classId}`);
	const main = groups(rng, kind, senior, false);
	const step = groups(rng, kind, senior, true);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(kind, senior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'tokens' } },
		changeStep: { markdown: changeStatement(kind, senior), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(kind, senior, false, 'right'),
			changeSource: referenceSource(kind, senior, true, 'right')
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, kind, senior)
						? { kind: 'program' as const, source: referenceSource(kind, senior, false, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
