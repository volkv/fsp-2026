// A module of client-side controllers (search suggestions, a loader, tabs, a form, autosave; a level up, live search
// with debounce and abort, an optimistic toggle, a request cache, a paginated feed), each with its contract in the
// comment above it. Exactly one line breaks its class's contract when answers come back out of order, a newer request
// supersedes an older one or a call repeats while a request is in flight. The candidate names that line.
//
// The network is a fake `api(arg, signal)` of the checks: every answer arrives after a set delay on a timer, an
// aborted signal rejects with `AbortError`. The checks run the timers on a virtual clock and look at the state at
// fixed moments away from every answer, so the verdict never depends on the load of the machine. The defect's kind
// is the essential class; the other classes, their order and the module header are surface.
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

/** A defect: the original line it replaces (`at`, unique in its unit), and a plausible but wrong neighbouring change. */
interface Defect {
	kind: string;
	at: string;
	text: string;
	neighbour: { at: string; text: string };
}

/** A class of the module: its lines, the checks of its contract (JavaScript run at the start) and its defects. */
interface Unit {
	lines: string[];
	checks: string[];
	defects: Defect[];
}

const MIDDLE: Unit[] = [
	{
		lines: [
			'/**',
			' * Подсказки поиска. search(q) запрашивает подсказки для q. В items всегда ответ',
			' * на последний вызов search, даже если ответы приходят не в том порядке, в каком',
			' * ушли запросы.',
			' */',
			'class Suggest {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.items = null;',
			'    this.seq = 0;',
			'  }',
			'',
			'  async search(q) {',
			'    const id = ++this.seq;',
			'    const items = await this.api(q);',
			'    if (id !== this.seq) return;',
			'    this.items = items;',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const s = new Suggest(__fakeApi({ a: { ms: 90 }, ab: { ms: 20 }, abc: { ms: 50 } }));',
			"  for (const q of ['a', 'ab', 'abc']) __quiet(s.search(q));",
			"  __expectAt(35, 'Suggest: старый ответ раньше последнего', () => s.items === null);",
			"  __expectAt(70, 'Suggest: ответ на последний запрос', () => s.items === 'data:abc');",
			"  __expectAt(130, 'Suggest: поздний устаревший ответ', () => s.items === 'data:abc');",
			'}'
		],
		defects: [
			{
				kind: 'stale-response',
				at: '    if (id !== this.seq) return;',
				text: '    if (id > this.seq) return;',
				neighbour: { at: '    const id = ++this.seq;', text: '    const id = (this.seq += 1);' }
			},
			{
				kind: 'stale-response',
				at: '    const id = ++this.seq;',
				text: '    const id = this.seq++;',
				neighbour: { at: '    this.items = items;', text: '    this.items = items ?? this.items;' }
			}
		]
	},
	{
		lines: [
			'/**',
			' * Профиль пользователя. show(userId) загружает профиль в profile. Если до ответа',
			' * снова вызвали show или вызвали close(), устаревший ответ в profile не попадает.',
			' */',
			'class ProfileView {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.profile = null;',
			'    this.cancel = null;',
			'  }',
			'',
			'  show(userId) {',
			'    this.cancel?.();',
			'    let active = true;',
			'    this.cancel = () => {',
			'      active = false;',
			'    };',
			'    return this.api(userId).then((profile) => {',
			'      if (active) this.profile = profile;',
			'    });',
			'  }',
			'',
			'  close() {',
			'    if (this.cancel) this.cancel();',
			'    this.profile = null;',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const v = new ProfileView(__fakeApi({ u1: { ms: 90 }, u2: { ms: 30 }, u3: { ms: 50 } }));',
			"  __quiet(v.show('u1'));",
			"  __quiet(v.show('u2'));",
			"  __expectAt(130, 'ProfileView: устаревший профиль', () => v.profile === 'data:u2');",
			'  const w = new ProfileView(__fakeApi({ u3: { ms: 50 } }));',
			"  __quiet(w.show('u3'));",
			'  w.close();',
			"  __expectAt(80, 'ProfileView: ответ после close', () => w.profile === null);",
			'}'
		],
		defects: [
			{
				kind: 'stale-response',
				at: '      if (active) this.profile = profile;',
				text: '      if (this.cancel) this.profile = profile;',
				neighbour: { at: '    let active = true;', text: '    let active = !false;' }
			},
			{
				kind: 'stale-response',
				at: '    this.cancel?.();',
				text: '    this.cancel = null;',
				neighbour: { at: '      active = false;', text: '      active = !true;' }
			}
		]
	},
	{
		lines: [
			'/**',
			' * Карточка товара. load(id) загружает данные в data. loading === true с вызова',
			' * load до ответа на последний вызов, после него — false. В data — ответ на последний',
			' * вызов load.',
			' */',
			'class Loader {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.loading = false;',
			'    this.data = null;',
			'    this.seq = 0;',
			'  }',
			'',
			'  async load(id) {',
			'    const req = ++this.seq;',
			'    this.loading = true;',
			'    try {',
			'      const data = await this.api(id);',
			'      if (req === this.seq) this.data = data;',
			'    } finally {',
			'      if (req === this.seq) this.loading = false;',
			'    }',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const l = new Loader(__fakeApi({ p1: { ms: 20 }, p2: { ms: 80 } }));',
			"  __quiet(l.load('p1'));",
			"  __quiet(l.load('p2'));",
			"  __expectAt(50, 'Loader: индикатор, пока идёт последний запрос', () => l.loading === true);",
			"  __expectAt(120, 'Loader: итог', () => l.loading === false && l.data === 'data:p2');",
			'}'
		],
		defects: [
			{
				kind: 'loading-flag',
				at: '      if (req === this.seq) this.loading = false;',
				text: '      this.loading = false;',
				neighbour: {
					at: '      if (req === this.seq) this.data = data;',
					text: '      if (req >= this.seq) this.data = data;'
				}
			},
			{
				kind: 'loading-flag',
				at: '    const req = ++this.seq;',
				text: '    const req = this.seq;',
				neighbour: { at: '    this.loading = true;', text: '    this.loading = !false;' }
			}
		]
	},
	{
		lines: [
			'/**',
			' * Вкладки. open(tab) загружает содержимое вкладки в content и через AbortController',
			' * отменяет незавершённый запрос предыдущей вкладки. Отменённый запрос не меняет',
			' * ни content, ни error; ошибка последнего запроса попадает в error.',
			' */',
			'class Tabs {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.controller = null;',
			'    this.content = null;',
			'    this.error = null;',
			'  }',
			'',
			'  async open(tab) {',
			'    this.controller?.abort();',
			'    const controller = new AbortController();',
			'    this.controller = controller;',
			'    try {',
			'      this.content = await this.api(tab, controller.signal);',
			'      this.error = null;',
			'    } catch (e) {',
			"      if (e.name === 'AbortError') return;",
			'      this.error = e.message;',
			'    }',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const api = __fakeApi({ news: { ms: 90 }, mail: { ms: 50 } });',
			'  const t = new Tabs(api);',
			"  __quiet(t.open('news'));",
			"  __quiet(t.open('mail'));",
			"  __expectAt(25, 'Tabs: отмена — не ошибка', () => t.error === null);",
			"  __expectAt(130, 'Tabs: содержимое последней вкладки', () => t.content === 'data:mail' && t.error === null);",
			"  __expectAt(130, 'Tabs: прежний запрос отменён', () => api.aborted.join() === 'news');",
			'  const u = new Tabs(__fakeApi({ chat: { ms: 40, fail: true } }));',
			"  __quiet(u.open('chat'));",
			"  __expectAt(70, 'Tabs: ошибка запроса', () => u.error === 'failed chat');",
			'}'
		],
		defects: [
			{
				kind: 'abort',
				at: '      this.content = await this.api(tab, controller.signal);',
				text: '      this.content = await this.api(tab);',
				neighbour: { at: '    this.controller = controller;', text: '    this.controller = controller ?? null;' }
			},
			{
				kind: 'abort',
				at: "      if (e.name === 'AbortError') return;",
				text: '      if (e instanceof TypeError) return;',
				neighbour: { at: '      this.error = e.message;', text: '      this.error = String(e.message);' }
			}
		]
	},
	{
		lines: [
			'/**',
			' * Отправка заявки. submit(form) отправляет форму один раз: повторный вызов, пока',
			' * запрос не завершён, не отправляет её снова и возвращает тот же промис. После',
			' * завершения запроса — успешного или с ошибкой — форму можно отправить снова.',
			' */',
			'class SubmitForm {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.pending = null;',
			'  }',
			'',
			'  submit(form) {',
			'    if (this.pending) return this.pending;',
			'    this.pending = this.api(form).finally(() => {',
			'      this.pending = null;',
			'    });',
			'    return this.pending;',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const api = __fakeApi({ order: [{ ms: 30, fail: true }, { ms: 30 }] });',
			'  const f = new SubmitForm(api);',
			"  const first = f.submit('order');",
			"  const second = f.submit('order');",
			'  __quiet(first);',
			"  __expectAt(10, 'SubmitForm: повтор возвращает тот же промис', () => first === second && api.calls.length === 1);",
			"  setTimeout(() => __quiet(f.submit('order')), 60);",
			"  __expectAt(120, 'SubmitForm: после ошибки форма уходит снова', () => api.calls.length === 2);",
			'}'
		],
		defects: [
			{
				kind: 'double-submit',
				at: '    this.pending = this.api(form).finally(() => {',
				text: '    this.pending = this.api(form).then(() => {',
				neighbour: { at: '      this.pending = null;', text: '      this.pending = undefined;' }
			},
			{
				kind: 'double-submit',
				at: '    if (this.pending) return this.pending;',
				text: '    if (!this.pending) return this.pending;',
				neighbour: { at: '    return this.pending;', text: '    return Promise.resolve(this.pending);' }
			}
		]
	},
	{
		lines: [
			'/**',
			' * Автосохранение. save(text) отправляет черновик. Одновременно идёт не больше одного',
			' * запроса: вызов во время отправки только запоминает текст, а после ответа уходит',
			' * последний запомненный текст. savedText — текст последнего сохранённого запроса.',
			' */',
			'class Autosave {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.inflight = false;',
			'    this.queued = null;',
			'    this.savedText = null;',
			'  }',
			'',
			'  async save(text) {',
			'    if (this.inflight) {',
			'      this.queued = text;',
			'      return;',
			'    }',
			'    this.inflight = true;',
			'    try {',
			'      await this.api(text);',
			'      this.savedText = text;',
			'    } finally {',
			'      this.inflight = false;',
			'    }',
			'    if (this.queued !== null) {',
			'      const next = this.queued;',
			'      this.queued = null;',
			'      await this.save(next);',
			'    }',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const api = __fakeApi({ v1: { ms: 40 }, v2: { ms: 30 }, v3: { ms: 30 } });',
			'  const a = new Autosave(api);',
			"  for (const text of ['v1', 'v2', 'v3']) __quiet(a.save(text));",
			"  __expectAt(20, 'Autosave: один запрос за раз', () => api.calls.join() === 'v1');",
			"  __expectAt(120, 'Autosave: уходит последний текст', () => api.calls.join() === 'v1,v3');",
			"  __expectAt(120, 'Autosave: сохранено', () => a.savedText === 'v3' && api.maxActive === 1);",
			'}'
		],
		defects: [
			{
				kind: 'double-submit',
				at: '      this.queued = text;',
				text: '      this.queued ??= text;',
				neighbour: { at: '      const next = this.queued;', text: '      const next = this.queued ?? text;' }
			},
			{
				kind: 'double-submit',
				at: '    if (this.inflight) {',
				text: '    if (this.inflight && this.queued) {',
				neighbour: { at: '    this.inflight = true;', text: '    this.inflight = !false;' }
			}
		]
	}
];

const SENIOR: Unit[] = [
	{
		lines: [
			'/**',
			' * Живой поиск. input(q) ждёт delay мс без нового ввода и только потом запрашивает',
			' * результаты; новый ввод отменяет и ожидание, и уже отправленный запрос. В results —',
			' * ответ на последний ввод, в error — ошибка последнего запроса; отмена ошибкой не',
			' * считается.',
			' */',
			'class LiveSearch {',
			'  constructor(api, delay) {',
			'    this.api = api;',
			'    this.delay = delay;',
			'    this.timer = null;',
			'    this.controller = null;',
			'    this.results = null;',
			'    this.error = null;',
			'  }',
			'',
			'  input(q) {',
			'    clearTimeout(this.timer);',
			'    this.controller?.abort();',
			'    this.timer = setTimeout(() => this.run(q), this.delay);',
			'  }',
			'',
			'  async run(q) {',
			'    const controller = new AbortController();',
			'    this.controller = controller;',
			'    try {',
			'      this.results = await this.api(q, controller.signal);',
			'      this.error = null;',
			'    } catch (e) {',
			'      if (!controller.signal.aborted) this.error = e.message;',
			'    }',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const api = __fakeApi({ r: { ms: 150 }, re: { ms: 90 }, rea: { ms: 20 } });',
			'  const s = new LiveSearch(api, 40);',
			"  s.input('r');",
			"  setTimeout(() => s.input('re'), 10);",
			"  setTimeout(() => s.input('rea'), 80);",
			"  __expectAt(100, 'LiveSearch: отмена — не ошибка', () => s.error === null);",
			"  __expectAt(250, 'LiveSearch: ответ на последний ввод', () => s.results === 'data:rea' && s.error === null);",
			"  __expectAt(250, 'LiveSearch: запросы и отмены', () => api.calls.join() === 're,rea' && api.aborted.join() === 're');",
			'}'
		],
		defects: [
			{
				kind: 'abort-lifecycle',
				at: '    clearTimeout(this.timer);',
				text: '    clearTimeout(this.controller);',
				neighbour: {
					at: '    this.timer = setTimeout(() => this.run(q), this.delay);',
					text: '    this.timer = setTimeout(this.run.bind(this, q), this.delay);'
				}
			},
			{
				kind: 'abort-lifecycle',
				at: '      if (!controller.signal.aborted) this.error = e.message;',
				text: '      this.error = e.message;',
				neighbour: { at: '      this.error = null;', text: '      if (this.error !== null) this.error = null;' }
			},
			{
				kind: 'abort-lifecycle',
				at: '    const controller = new AbortController();',
				text: '    const controller = (this.controller ??= new AbortController());',
				neighbour: {
					at: '    this.controller = controller;',
					text: '    this.controller = controller || this.controller;'
				}
			}
		]
	},
	{
		lines: [
			'/**',
			' * Кнопка «нравится». toggle() сразу меняет liked и count, затем сохраняет состояние',
			' * на сервере. Если запрос упал, состояние откатывается к тому, что было перед этим',
			' * toggle, — но только если после него не было других toggle.',
			' */',
			'class LikeButton {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.liked = false;',
			'    this.count = 10;',
			'    this.version = 0;',
			'  }',
			'',
			'  async toggle() {',
			'    const before = { liked: this.liked, count: this.count };',
			'    const version = ++this.version;',
			'    this.liked = !this.liked;',
			'    this.count += this.liked ? 1 : -1;',
			'    try {',
			"      await this.api(this.liked ? 'like' : 'unlike');",
			'    } catch {',
			'      if (version !== this.version) return;',
			'      this.liked = before.liked;',
			'      this.count = before.count;',
			'    }',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const b = new LikeButton(__fakeApi({ like: [{ ms: 90, fail: true }, { ms: 50 }], unlike: { ms: 20 } }));',
			'  for (let i = 0; i < 3; i += 1) __quiet(b.toggle());',
			"  __expectAt(130, 'LikeButton: поздний откат', () => b.liked === true && b.count === 11);",
			'  const c = new LikeButton(__fakeApi({ like: { ms: 30, fail: true } }));',
			'  __quiet(c.toggle());',
			"  __expectAt(70, 'LikeButton: откат', () => c.liked === false && c.count === 10);",
			'}'
		],
		defects: [
			{
				kind: 'optimistic-rollback',
				at: '      if (version !== this.version) return;',
				text: '      if (version > this.version) return;',
				neighbour: { at: '      this.liked = before.liked;', text: '      this.liked = Boolean(before.liked);' }
			},
			{
				kind: 'optimistic-rollback',
				at: '    const version = ++this.version;',
				text: '    const version = this.version;',
				neighbour: {
					at: '    this.count += this.liked ? 1 : -1;',
					text: '    this.count = this.count + (this.liked ? 1 : -1);'
				}
			},
			{
				kind: 'optimistic-rollback',
				at: '    const before = { liked: this.liked, count: this.count };',
				text: '    const before = this;',
				neighbour: { at: '      this.count = before.count;', text: '      this.count = Number(before.count);' }
			}
		]
	},
	{
		lines: [
			'/**',
			' * Кэш пользователей. get(id) запрашивает пользователя один раз: одновременные вызовы',
			' * с тем же id получают тот же промис, готовый ответ отдаётся без нового запроса.',
			' * Ошибку запроса получают все, кто его ждал, но в кэше она не остаётся: следующий',
			' * get(id) запрашивает снова.',
			' */',
			'class UserCache {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.cache = new Map();',
			'  }',
			'',
			'  get(id) {',
			'    const hit = this.cache.get(id);',
			'    if (hit) return hit;',
			'    const request = this.api(id).catch((error) => {',
			'      this.cache.delete(id);',
			'      throw error;',
			'    });',
			'    this.cache.set(id, request);',
			'    return request;',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const api = __fakeApi({ 7: [{ ms: 30, fail: true }, { ms: 30 }], 8: { ms: 20 } });',
			'  const c = new UserCache(api);',
			'  const seen = [];',
			'  const note = (p) => p.then((v) => seen.push(v), (e) => seen.push(`error ${e.message}`));',
			'  note(c.get(7));',
			'  note(c.get(7));',
			'  note(c.get(8));',
			'  setTimeout(() => note(c.get(7)), 60);',
			'  setTimeout(() => note(c.get(8)), 60);',
			'  setTimeout(() => note(c.get(7)), 120);',
			"  __expectAt(150, 'UserCache: запросы', () => api.calls.join() === '7,8,7');",
			'  __expectAt(',
			'    150,',
			"    'UserCache: ответы',",
			"    () => seen.join() === 'data:8,error failed 7,error failed 7,data:8,data:7,data:7'",
			'  );',
			'}'
		],
		defects: [
			{
				kind: 'inflight-cache',
				at: '    this.cache.set(id, request);',
				text: '    this.cache.set(`${id}`, request);',
				neighbour: {
					at: '    const hit = this.cache.get(id);',
					text: '    const hit = this.cache.has(id) ? this.cache.get(id) : undefined;'
				}
			},
			{
				kind: 'inflight-cache',
				at: '      throw error;',
				text: '      return null;',
				neighbour: { at: '      this.cache.delete(id);', text: '      if (this.cache.has(id)) this.cache.delete(id);' }
			},
			{
				kind: 'inflight-cache',
				at: '    const request = this.api(id).catch((error) => {',
				text: '    const request = this.api(id).finally((error) => {',
				neighbour: { at: '    return request;', text: '    return this.cache.get(id) ?? request;' }
			}
		]
	},
	{
		lines: [
			'/**',
			' * Лента. more() догружает следующую страницу и дописывает её в items. Пока страница',
			' * грузится, повторный more() ничего не делает. reset() очищает ленту: ответ на',
			' * запрос, отправленный до reset, в неё не попадает и loading не трогает.',
			' */',
			'class Feed {',
			'  constructor(api) {',
			'    this.api = api;',
			'    this.items = [];',
			'    this.page = 0;',
			'    this.loading = false;',
			'    this.epoch = 0;',
			'  }',
			'',
			'  async more() {',
			'    if (this.loading) return;',
			'    this.loading = true;',
			'    const epoch = this.epoch;',
			'    try {',
			'      const items = await this.api(this.page + 1);',
			'      if (epoch !== this.epoch) return;',
			'      this.items = [...this.items, items];',
			'      this.page += 1;',
			'    } finally {',
			'      if (epoch === this.epoch) this.loading = false;',
			'    }',
			'  }',
			'',
			'  reset() {',
			'    this.epoch += 1;',
			'    this.items = [];',
			'    this.page = 0;',
			'    this.loading = false;',
			'  }',
			'}'
		],
		checks: [
			'{',
			'  const api = __fakeApi({ 1: { ms: 40 }, 2: { ms: 30 } });',
			'  const f = new Feed(api);',
			'  __quiet(f.more());',
			'  __quiet(f.more());',
			'  setTimeout(() => __quiet(f.more()), 60);',
			"  __expectAt(130, 'Feed: страницы по одной', () => api.calls.join() === '1,2' && f.items.join() === 'data:1,data:2');",
			'  const g = new Feed(__fakeApi({ 1: [{ ms: 60 }, { ms: 100 }] }));',
			'  __quiet(g.more());',
			'  g.reset();',
			'  __quiet(g.more());',
			"  __expectAt(80, 'Feed: старый ответ после reset', () => g.loading === true && g.items.length === 0);",
			"  __expectAt(130, 'Feed: итог после reset', () => g.items.join() === 'data:1' && g.page === 1 && !g.loading);",
			'}'
		],
		defects: [
			{
				kind: 'pagination',
				at: '      if (epoch !== this.epoch) return;',
				text: '      if (epoch > this.epoch) return;',
				neighbour: { at: '      this.page += 1;', text: '      this.page = this.page + 1;' }
			},
			{
				kind: 'pagination',
				at: '      if (epoch === this.epoch) this.loading = false;',
				text: '      this.loading = false;',
				neighbour: { at: '    const epoch = this.epoch;', text: '    const epoch = Number(this.epoch);' }
			},
			{
				kind: 'pagination',
				at: '    if (this.loading) return;',
				text: '    if (this.loading && this.page > 0) return;',
				neighbour: { at: '    this.loading = true;', text: '    this.loading = !false;' }
			}
		]
	}
];

/**
 * The checks' clock, fake network and verdict, appended before the checks of the classes. Timers run on a virtual
 * clock: the next timer fires once every job before it has run, so the checks are exact and take no real time.
 */
const CHECK_PRELUDE = [
	'const __realImmediate = setImmediate;',
	'const __timers = [];',
	'let __now = 0;',
	'let __seq = 0;',
	'globalThis.setTimeout = (fn, ms = 0, ...args) => {',
	'  const timer = { at: __now + Math.max(0, Number(ms) || 0), seq: __seq++, fn, args, off: false };',
	'  __timers.push(timer);',
	'  return timer;',
	'};',
	'globalThis.clearTimeout = (timer) => {',
	'  if (timer && typeof timer === "object") timer.off = true;',
	'};',
	'async function __runClock(until) {',
	'  for (let steps = 0; steps < 10000; steps += 1) {',
	'    await new Promise((resolve) => __realImmediate(resolve));',
	'    const live = __timers.filter((t) => !t.off && t.at <= until);',
	'    if (live.length === 0) return;',
	'    live.sort((a, b) => a.at - b.at || a.seq - b.seq);',
	'    const next = live[0];',
	'    next.off = true;',
	'    __now = next.at;',
	'    next.fn(...next.args);',
	'  }',
	'}',
	'const __problems = [];',
	'function __expectAt(ms, name, holds) {',
	'  setTimeout(() => {',
	'    try {',
	'      if (!holds()) __problems.push(name);',
	'    } catch (error) {',
	'      __problems.push(`${name}: ${error.message}`);',
	'    }',
	'  }, ms);',
	'}',
	'function __quiet(promise) {',
	'  if (promise && typeof promise.then === "function") promise.then(() => {}, () => {});',
	'}',
	'function __fakeApi(plan) {',
	'  const api = (arg, signal) => {',
	'    const key = String(arg);',
	'    const nth = api.calls.filter((c) => c === key).length;',
	'    api.calls.push(key);',
	'    const steps = [plan[key] ?? { ms: 10 }].flat();',
	'    const step = steps[Math.min(nth, steps.length - 1)];',
	'    return new Promise((resolve, reject) => {',
	'      const abort = () => {',
	'        api.aborted.push(key);',
	'        reject(new DOMException("Aborted", "AbortError"));',
	'      };',
	'      if (signal?.aborted) {',
	'        abort();',
	'        return;',
	'      }',
	'      api.active += 1;',
	'      api.maxActive = Math.max(api.maxActive, api.active);',
	'      let done = false;',
	'      const timer = setTimeout(() => {',
	'        done = true;',
	'        api.active -= 1;',
	'        if (step.fail) reject(new Error(`failed ${key}`));',
	'        else resolve(`data:${key}`);',
	'      }, step.ms);',
	'      signal?.addEventListener("abort", () => {',
	'        if (done) return;',
	'        done = true;',
	'        clearTimeout(timer);',
	'        api.active -= 1;',
	'        abort();',
	'      });',
	'    });',
	'  };',
	'  api.calls = [];',
	'  api.aborted = [];',
	'  api.active = 0;',
	'  api.maxActive = 0;',
	'  return api;',
	'}'
];

const CHECK_VERDICT = [
	'__runClock(1000).then(() => {',
	"  console.log(__problems.length === 0 ? 'ok' : `fail ${__problems.join('; ')}`);",
	'  process.exit(0);',
	'});'
];

const MODULE_TITLES = [
	'Контроллеры экрана заказов',
	'Клиентская логика личного кабинета',
	'Состояние страницы каталога',
	'Контроллеры панели оператора'
];
const HEADER_CONSTANTS = [
	'const PAGE_SIZE = 20;',
	"const API_VERSION = 'v2';",
	'const RETRY_LIMIT = 3;',
	'const DEBOUNCE_MS = 300;',
	"const LOCALE = 'ru-RU';",
	'const MAX_ITEMS = 500;'
];

/** The index of the line `at` in a unit; it must occur exactly once. */
function lineOf(unit: Unit, at: string): number {
	const index = unit.lines.indexOf(at);
	if (index === -1 || unit.lines.lastIndexOf(at) !== index) throw new Error(`line not unique in its unit: ${at}`);
	return index;
}

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
}

function compose(rng: Rng, library: readonly Unit[], kind: string, contextCount: number): Program {
	const candidates = library.flatMap((unit) =>
		unit.defects.filter((d) => d.kind === kind).map((defect) => ({ unit, defect }))
	);
	const { unit: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((unit) => unit !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A module header of random length, so the defect's line number carries no hint.
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 4));
	const lines: string[] = [`// ${rng.pick(MODULE_TITLES)}.`, ...(rng.bool() ? ["'use strict';"] : []), ''];
	if (constants.length) lines.push(...constants, '');
	const defectLine = lineOf(buggy, defect.at);
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	let other = { line: 0, text: '' };
	for (const unit of order) {
		const offset = lines.length;
		unit.lines.forEach((line, i) => lines.push(unit === buggy && i === defectLine ? defect.text : line));
		if (unit === buggy) {
			answer = offset + defectLine + 1;
			neighbour = { line: offset + lineOf(buggy, defect.neighbour.at) + 1, text: defect.neighbour.text };
		} else if (other.line === 0) {
			const sibling = rng.pick(unit.defects);
			other = { line: offset + lineOf(unit, sibling.at) + 1, text: sibling.text };
		}
		lines.push('');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const fix = buggy.lines[defectLine] ?? '';
	const check = ['', ...CHECK_PRELUDE, ...order.flatMap((unit) => unit.checks), ...CHECK_VERDICT].join('\n');
	return { source: lines.join('\n'), check, answer, fix, neighbour, other };
}

const API_NOTE = [
	'Модуль клиентской части на JavaScript. Каждый класс получает функцию запроса `api(arg, signal)`: она',
	'возвращает промис, который через некоторое время выполняется данными или отклоняется с `Error`; если',
	'переданный `signal` отменён (сам по себе или до ответа), промис отклоняется с `DOMException` по имени',
	'`AbortError`. Ответы на разные запросы приходят в любом порядке.',
	'',
	'Контракт каждого класса записан в комментарии над ним. Ровно одна строка модуля нарушает контракт своего',
	'класса: если заменить только её, все классы будут работать по контракту. Введите номер этой строки',
	'(нумерация с 1).'
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p = input.grade === 'middle' ? compose(rng, MIDDLE, input.classId, 2) : compose(rng, SENIOR, input.classId, 2);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: API_NOTE, code: { language: 'javascript', source: p.source } },
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
				distractors: [
					{ line: p.neighbour.line, replacement: p.neighbour.text },
					{ line: p.other.line, replacement: p.other.text }
				]
			}),
		wrong: () => ({
			'neighbour-line': { kind: 'answer', answer: { kind: 'line_no', value: p.neighbour.line } },
			'other-class': { kind: 'answer', answer: { kind: 'line_no', value: p.other.line } }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
