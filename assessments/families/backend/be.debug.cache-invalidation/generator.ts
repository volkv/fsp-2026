// A module of caching code: TTL caches, memoized lookups with composite keys, caches in front of a store with
// invalidation on writes — each with its contract in the docstring; exactly one line breaks its contract. The
// candidate names that line. Time and stores are injected, so every defect shows deterministically. The defect's kind
// is the essential class; the other units, their order and the module header are surface.
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

/** A defect: the original line it replaces (`at`, unique in its unit), and a plausible but wrong neighbouring change. */
interface Defect {
	kind: string;
	at: string;
	text: string;
	neighbour: { at: string; text: string };
	/** Other lines where a one-instruction replacement also restores the contract. */
	alternatives?: { at: string; text: string }[];
}

/** A class or function of the module: its lines, the checks of its contract and its possible defects. */
interface Unit {
	lines: string[];
	/** Python statements, each raising when the contract is broken. */
	checks: string[];
	defects: Defect[];
}

const MIDDLE: Unit[] = [
	{
		lines: [
			'class TtlCache:',
			'    """get(key) возвращает значение, если с момента записи прошло меньше ttl секунд, иначе None',
			'    (просроченная запись удаляется); set(key, value) запоминает значение и время записи.',
			'    now() — текущее время в секундах."""',
			'',
			'    def __init__(self, ttl, now):',
			'        self.ttl = ttl',
			'        self.now = now',
			'        self.data = {}',
			'',
			'    def get(self, key):',
			'        entry = self.data.get(key)',
			'        if entry is None:',
			'            return None',
			'        value, stored_at = entry',
			'        if self.now() - stored_at >= self.ttl:',
			'            del self.data[key]',
			'            return None',
			'        return value',
			'',
			'    def set(self, key, value):',
			'        self.data[key] = (value, self.now())'
		],
		checks: [
			'tc_t = [100]',
			'tc = TtlCache(30, lambda: tc_t[0])',
			'tc.set("a", 1)',
			'tc_t[0] = 129',
			'assert tc.get("a") == 1',
			'tc_t[0] = 130',
			'assert tc.get("a") is None and "a" not in tc.data',
			'tc.set("a", 2)',
			'assert tc.get("a") == 2'
		],
		defects: [
			{
				kind: 'ttl',
				at: '        if self.now() - stored_at >= self.ttl:',
				text: '        if self.now() - stored_at > self.ttl:',
				neighbour: { at: '        value, stored_at = entry', text: '        value, stored_at = entry[0], entry[1]' }
			},
			{
				kind: 'ttl',
				at: '        if self.now() - stored_at >= self.ttl:',
				text: '        if stored_at - self.now() >= self.ttl:',
				neighbour: { at: '            del self.data[key]', text: '            self.data.pop(key, None)' }
			}
		]
	},
	{
		lines: [
			'class RateCache:',
			'    """rate(code) — курс валюты: свежий из кэша или загруженный через fetch(code). Курс свежий',
			'    max_age_s секунд с момента загрузки; now_ms() — время в миллисекундах."""',
			'',
			'    def __init__(self, fetch, max_age_s, now_ms):',
			'        self.fetch = fetch',
			'        self.max_age_s = max_age_s',
			'        self.now_ms = now_ms',
			'        self.entries = {}',
			'',
			'    def _fresh(self, fetched_at):',
			'        return self.now_ms() - fetched_at < self.max_age_s * 1000',
			'',
			'    def rate(self, code):',
			'        entry = self.entries.get(code)',
			'        if entry is not None and self._fresh(entry[1]):',
			'            return entry[0]',
			'        value = self.fetch(code)',
			'        self.entries[code] = (value, self.now_ms())',
			'        return value'
		],
		checks: [
			'rc_t = [1_000_000]',
			'rc_calls = []',
			'def rc_fetch(code):',
			'    rc_calls.append(code)',
			'    return 90 + len(rc_calls)',
			'rc = RateCache(rc_fetch, 60, lambda: rc_t[0])',
			'assert rc.rate("USD") == 91',
			'rc_t[0] += 59_999',
			'assert rc.rate("USD") == 91',
			'rc_t[0] += 1',
			'assert rc.rate("USD") == 92',
			'assert rc_calls == ["USD", "USD"]'
		],
		defects: [
			{
				kind: 'ttl',
				at: '        return self.now_ms() - fetched_at < self.max_age_s * 1000',
				text: '        return self.now_ms() - fetched_at < self.max_age_s',
				neighbour: { at: '            return entry[0]', text: '            return entry[0] if entry else None' },
				// The age limit kept in milliseconds also restores the contract: the attribute's unit is not part of it.
				alternatives: [{ at: '        self.max_age_s = max_age_s', text: '        self.max_age_s = max_age_s * 1000' }]
			},
			{
				kind: 'ttl',
				at: '        return self.now_ms() - fetched_at < self.max_age_s * 1000',
				text: '        return self.now_ms() - fetched_at <= self.max_age_s * 1000',
				neighbour: { at: '        value = self.fetch(code)', text: '        value = self.fetch(code.upper())' }
			}
		]
	},
	{
		lines: [
			'class CatalogPages:',
			'    """page(category, page_no, lang) — страница каталога; render(category, page_no, lang) дорогой,',
			'    поэтому результат кэшируется по всем трём параметрам."""',
			'',
			'    def __init__(self, render):',
			'        self.render = render',
			'        self.cache = {}',
			'',
			'    def page(self, category, page_no, lang):',
			'        key = (category, page_no, lang)',
			'        if key not in self.cache:',
			'            self.cache[key] = self.render(category, page_no, lang)',
			'        return self.cache[key]'
		],
		checks: [
			'cp = CatalogPages(lambda c, p, l: f"{c}/{p}/{l}")',
			'assert cp.page("a", 11, "ru") == "a/11/ru"',
			'assert cp.page("a1", 1, "ru") == "a1/1/ru"',
			'assert cp.page("a", 11, "en") == "a/11/en"',
			'assert cp.page("a", 11, "ru") == "a/11/ru" and len(cp.cache) == 3'
		],
		defects: [
			{
				kind: 'key',
				at: '        key = (category, page_no, lang)',
				text: '        key = (category, page_no)',
				neighbour: { at: '        if key not in self.cache:', text: '        if self.cache.get(key) is None:' }
			},
			{
				kind: 'key',
				at: '        key = (category, page_no, lang)',
				text: '        key = f"{category}{page_no}{lang}"',
				neighbour: { at: '        return self.cache[key]', text: '        return self.cache.get(key)' }
			}
		]
	},
	{
		lines: [
			'def cached_feed(cache, user, limit, load):',
			'    """Лента пользователя из limit элементов через общий для всех пользователей кэш: ключ',
			'    различает пользователя и limit; load(user, limit) вызывается только при промахе."""',
			'    key = ("feed", user, limit)',
			'    if key not in cache:',
			'        cache[key] = load(user, limit)',
			'    return cache[key]'
		],
		checks: [
			'cf_cache, cf_calls = {}, []',
			'def cf_load(user, limit):',
			'    cf_calls.append((user, limit))',
			'    return [f"{user}:{i}" for i in range(limit)]',
			'assert cached_feed(cf_cache, "ann", 2, cf_load) == ["ann:0", "ann:1"]',
			'assert cached_feed(cf_cache, "bob", 2, cf_load) == ["bob:0", "bob:1"]',
			'assert cached_feed(cf_cache, "ann", 3, cf_load) == ["ann:0", "ann:1", "ann:2"]',
			'assert cached_feed(cf_cache, "ann", 2, cf_load) == ["ann:0", "ann:1"]',
			'assert len(cf_calls) == 3'
		],
		defects: [
			{
				kind: 'key',
				at: '    key = ("feed", user, limit)',
				text: '    key = ("feed", limit)',
				neighbour: { at: '    return cache[key]', text: '    return list(cache[key])' }
			},
			{
				kind: 'key',
				at: '    key = ("feed", user, limit)',
				text: '    key = ("feed", user)',
				neighbour: {
					at: '        cache[key] = load(user, limit)',
					text: '        cache[key] = list(load(user, limit))'
				}
			}
		]
	},
	{
		lines: [
			'def cached_search(cache, params, run):',
			'    """Поиск по параметрам запроса: params — словарь, ключи — строки, значения — строки или целые',
			'    числа (не bool). Одинаковые параметры в любом порядке дают один ключ кэша, разные значения — разные',
			'    ключи; run(params) вызывается только при промахе."""',
			'    key = tuple(sorted(params.items()))',
			'    if key not in cache:',
			'        cache[key] = run(params)',
			'    return cache[key]'
		],
		checks: [
			'cs_cache, cs_runs = {}, []',
			'def cs_run(params):',
			'    cs_runs.append(dict(params))',
			"    return f\"{params['q']}#{params['page']}\"",
			'assert cached_search(cs_cache, {"q": "go", "page": 2}, cs_run) == "go#2"',
			'assert cached_search(cs_cache, {"page": 2, "q": "go"}, cs_run) == "go#2"',
			'assert cached_search(cs_cache, {"q": "go", "page": 3}, cs_run) == "go#3"',
			'assert cached_search(cs_cache, {"q": "tea", "page": 1, "sort": "price"}, cs_run) == "tea#1"',
			'assert cached_search(cs_cache, {"sort": "price", "page": 1, "q": "tea"}, cs_run) == "tea#1"',
			'assert len(cs_runs) == 3'
		],
		defects: [
			{
				kind: 'key',
				at: '    key = tuple(sorted(params.items()))',
				text: '    key = tuple(params.items())',
				neighbour: { at: '    if key not in cache:', text: '    if cache.get(key) is None:' }
			},
			{
				kind: 'key',
				at: '    key = tuple(sorted(params.items()))',
				text: '    key = tuple(sorted(params))',
				neighbour: { at: '        cache[key] = run(params)', text: '        cache[key] = run(dict(params))' }
			}
		]
	},
	{
		lines: [
			'class UserRepo:',
			'    """get(user_id) — профиль из кэша или из базы; update(user_id, fields) меняет запись в базе,',
			'    и следующий get видит изменения. Идентификаторы — целые числа."""',
			'',
			'    def __init__(self, db):',
			'        self.db = db',
			'        self.cache = {}',
			'',
			'    def get(self, user_id):',
			'        if user_id not in self.cache:',
			'            self.cache[user_id] = dict(self.db[user_id])',
			'        return dict(self.cache[user_id])',
			'',
			'    def update(self, user_id, fields):',
			'        self.db[user_id].update(fields)',
			'        self.cache.pop(user_id, None)'
		],
		checks: [
			'ur = UserRepo({1: {"name": "ann", "city": "Омск"}})',
			'assert ur.get(1)["city"] == "Омск"',
			'ur.update(1, {"city": "Томск"})',
			'assert ur.get(1) == {"name": "ann", "city": "Томск"}'
		],
		defects: [
			{
				kind: 'invalidation',
				at: '        self.cache.pop(user_id, None)',
				text: '        self.cache.pop(str(user_id), None)',
				neighbour: { at: '        self.db[user_id].update(fields)', text: '        self.db[user_id].update(**fields)' }
			}
		]
	},
	{
		lines: [
			'class GeoLookup:',
			'    """city(ip) — город по IP через lookup(ip). Найденный город кэшируется; если lookup вернул None',
			'    (город неизвестен) или бросил LookupError, city возвращает None и ничего не кэширует —',
			'    следующий вызов спросит снова."""',
			'',
			'    def __init__(self, lookup):',
			'        self.lookup = lookup',
			'        self.cache = {}',
			'',
			'    def city(self, ip):',
			'        if ip in self.cache:',
			'            return self.cache[ip]',
			'        try:',
			'            result = self.lookup(ip)',
			'        except LookupError:',
			'            return None',
			'        if result is not None:',
			'            self.cache[ip] = result',
			'        return result'
		],
		checks: [
			'gl_answers = {"1.1.1.1": [None, "Омск"], "2.2.2.2": ["error", "Томск"]}',
			'gl_calls = []',
			'def gl_lookup(ip):',
			'    gl_calls.append(ip)',
			'    answer = gl_answers[ip].pop(0)',
			'    if answer == "error":',
			'        raise LookupError(ip)',
			'    return answer',
			'gl = GeoLookup(gl_lookup)',
			'assert gl.city("1.1.1.1") is None',
			'assert gl.city("1.1.1.1") == "Омск" and gl.city("1.1.1.1") == "Омск"',
			'assert gl.city("2.2.2.2") is None and gl.city("2.2.2.2") == "Томск"',
			'assert gl_calls == ["1.1.1.1", "1.1.1.1", "2.2.2.2", "2.2.2.2"]'
		],
		defects: [
			{
				kind: 'invalidation',
				at: '        if result is not None:',
				text: '        if ip not in self.cache:',
				neighbour: { at: '            return self.cache[ip]', text: '            return self.cache.get(ip)' }
			}
		]
	},
	{
		lines: [
			'class SettingsStore:',
			'    """value(name) — из кэша или из хранилища; save(name, value) пишет в хранилище и обновляет',
			'    кэш тем значением, которое хранилище реально сохранило (оно нормализует значения)."""',
			'',
			'    def __init__(self, store):',
			'        self.store = store',
			'        self.cache = {}',
			'',
			'    def value(self, name):',
			'        if name not in self.cache:',
			'            self.cache[name] = self.store.read(name)',
			'        return self.cache[name]',
			'',
			'    def save(self, name, value):',
			'        stored = self.store.write(name, value)',
			'        self.cache[name] = stored'
		],
		checks: [
			'class SsBackend:',
			'    def __init__(self):',
			'        self.data = {"mode": "auto"}',
			'    def read(self, name):',
			'        return self.data[name]',
			'    def write(self, name, value):',
			'        self.data[name] = value.strip().lower()',
			'        return self.data[name]',
			'ss = SettingsStore(SsBackend())',
			'assert ss.value("mode") == "auto"',
			'ss.save("mode", " Manual ")',
			'assert ss.value("mode") == "manual"'
		],
		defects: [
			{
				kind: 'invalidation',
				at: '        self.cache[name] = stored',
				text: '        self.cache[name] = value',
				neighbour: {
					at: '        stored = self.store.write(name, value)',
					text: '        stored = self.store.write(name, str(value))'
				}
			}
		]
	},
	{
		lines: [
			'class Catalog:',
			'    """items_in(category) — отсортированные id товаров категории, результат кэшируется;',
			'    add(item_id, item) добавляет товар или заменяет товар с тем же id (в том числе с другой',
			'    категорией), и следующие вызовы items_in видят каталог после изменения."""',
			'',
			'    def __init__(self):',
			'        self.items = {}',
			'        self._by_category = {}',
			'',
			'    def items_in(self, category):',
			'        if category not in self._by_category:',
			'            ids = [i for i, it in self.items.items() if it["category"] == category]',
			'            self._by_category[category] = sorted(ids)',
			'        return list(self._by_category[category])',
			'',
			'    def add(self, item_id, item):',
			'        old = self.items.get(item_id)',
			'        self.items[item_id] = item',
			'        self._by_category.pop(item["category"], None)',
			'        if old is not None:',
			'            self._by_category.pop(old["category"], None)'
		],
		checks: [
			'cat = Catalog()',
			'cat.add(3, {"category": "tea"})',
			'assert cat.items_in("tea") == [3]',
			'cat.add(1, {"category": "tea"})',
			'cat.add(2, {"category": "coffee"})',
			'assert cat.items_in("tea") == [1, 3] and cat.items_in("coffee") == [2]',
			'cat.add(1, {"category": "coffee"})',
			'assert cat.items_in("tea") == [3] and cat.items_in("coffee") == [1, 2]'
		],
		defects: [
			{
				kind: 'invalidation',
				at: '        self._by_category.pop(item["category"], None)',
				text: '        self._by_category.pop(item_id, None)',
				neighbour: { at: '        self.items[item_id] = item', text: '        self.items[item_id] = dict(item)' }
			}
		]
	}
];

/** Units of the reserve class X: they serve only its instances, so the instances of the other classes stay as they were. */
const MIDDLE_X: Unit[] = [
	{
		lines: [
			'class TenantCache:',
			'    """Кэш отчётов: get(tenant, report, build) — из кэша или build(). invalidate(tenant) делает устаревшими',
			'    все отчёты арендатора сразу, увеличивая его версию; отчёты других арендаторов не затрагиваются."""',
			'',
			'    def __init__(self):',
			'        self.data = {}',
			'        self.versions = {}',
			'',
			'    def _key(self, tenant, report):',
			'        return (tenant, self.versions.get(tenant, 0), report)',
			'',
			'    def get(self, tenant, report, build):',
			'        key = self._key(tenant, report)',
			'        if key not in self.data:',
			'            self.data[key] = build()',
			'        return self.data[key]',
			'',
			'    def invalidate(self, tenant):',
			'        self.versions[tenant] = self.versions.get(tenant, 0) + 1'
		],
		checks: [
			'tn_n = [0]',
			'def tn_build():',
			'    tn_n[0] += 1',
			'    return tn_n[0]',
			'tn = TenantCache()',
			'assert tn.get("a", "r", tn_build) == 1 and tn.get("b", "r", tn_build) == 2',
			'tn.invalidate("a")',
			'assert tn.get("a", "r", tn_build) == 3 and tn.get("b", "r", tn_build) == 2',
			'tn.invalidate("a")',
			'assert tn.get("a", "r", tn_build) == 4'
		],
		defects: [
			{
				kind: 'namespace',
				at: '        return (tenant, self.versions.get(tenant, 0), report)',
				text: '        return (tenant, report)',
				neighbour: { at: '        if key not in self.data:', text: '        if self.data.get(key) is None:' }
			},
			{
				kind: 'namespace',
				at: '        self.versions[tenant] = self.versions.get(tenant, 0) + 1',
				text: '        self.versions[tenant] = 1',
				neighbour: { at: '        return self.data[key]', text: '        return self.data.get(key)' }
			},
			{
				kind: 'namespace',
				at: '        return (tenant, self.versions.get(tenant, 0), report)',
				text: '        return (tenant, self.versions.get(report, 0), report)',
				neighbour: {
					at: '            self.data[key] = build()',
					text: '            self.data.setdefault(key, build())'
				}
			}
		]
	},
	{
		lines: [
			'class PrefixCache:',
			'    """put(key, value) и get(key), ключи — строки; drop_prefix(prefix) удаляет все ключи, которые',
			'    начинаются с prefix, и только их."""',
			'',
			'    def __init__(self):',
			'        self.data = {}',
			'',
			'    def put(self, key, value):',
			'        self.data[key] = value',
			'',
			'    def get(self, key):',
			'        return self.data.get(key)',
			'',
			'    def drop_prefix(self, prefix):',
			'        for key in [k for k in self.data if k.startswith(prefix)]:',
			'            del self.data[key]'
		],
		checks: [
			'pc = PrefixCache()',
			'for pc_key in ("user:1", "user:2", "admin:user:3", "users:9"):',
			'    pc.put(pc_key, pc_key.upper())',
			'pc.drop_prefix("user:")',
			'assert sorted(pc.data) == ["admin:user:3", "users:9"]'
		],
		defects: [
			{
				kind: 'namespace',
				at: '        for key in [k for k in self.data if k.startswith(prefix)]:',
				text: '        for key in [k for k in self.data if prefix in k]:',
				neighbour: { at: '            del self.data[key]', text: '            self.data.pop(key)' }
			},
			{
				kind: 'namespace',
				at: '        for key in [k for k in self.data if k.startswith(prefix)]:',
				text: '        for key in [k for k in self.data if k.startswith(prefix.rstrip(":"))]:',
				neighbour: { at: '        self.data[key] = value', text: '        self.data[str(key)] = value' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Кэши сервиса каталога',
	'Кэширование ответов внешних API',
	'Слой кэша перед базой данных',
	'Кэши профилей и настроек'
];
const OPTIONAL_IMPORTS = ['import logging', 'import time', 'import json', 'import functools'];
const HEADER_CONSTANTS = [
	'DEFAULT_TTL = 300',
	'MAX_ENTRIES = 10_000',
	'NAMESPACE = "catalog"',
	'RATES_MAX_AGE_S = 60',
	'FEED_LIMIT = 20',
	'CACHE_VERSION = 3'
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
	/** Accepted other repairs: absolute line and its replacement. */
	alternatives: { line: number; fix: string }[];
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
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		'',
		...rng.sample(OPTIONAL_IMPORTS, rng.int(1, 3)).sort(),
		...(constants.length ? ['', ...constants] : []),
		'',
		''
	];
	const defectLine = lineOf(buggy, defect.at);
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	let other = { line: 0, text: '' };
	let alternatives: Program['alternatives'] = [];
	for (const unit of order) {
		const offset = lines.length;
		unit.lines.forEach((line, i) => lines.push(unit === buggy && i === defectLine ? defect.text : line));
		if (unit === buggy) {
			answer = offset + defectLine + 1;
			alternatives = (defect.alternatives ?? []).map((a) => ({ line: offset + lineOf(buggy, a.at) + 1, fix: a.text }));
			neighbour = { line: offset + lineOf(buggy, defect.neighbour.at) + 1, text: defect.neighbour.text };
		} else if (other.line === 0) {
			const sibling = unit.defects[0];
			if (sibling) other = { line: offset + lineOf(unit, sibling.at) + 1, text: sibling.text };
		}
		lines.push('', '');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const fix = buggy.lines[defectLine] ?? '';
	const checks = order.flatMap((unit) => unit.checks);
	const check = [
		'def _spec():',
		...checks.map((c) => `    ${c}`),
		'',
		'try:',
		'    _spec()',
		"    print('ok')",
		'except Exception as exc:',
		"    print('fail', type(exc).__name__)"
	].join('\n');
	return { source: lines.join('\n'), check, answer, fix, neighbour, other, alternatives };
}

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p = compose(rng, cls.form === 'X' ? [...MIDDLE, ...MIDDLE_X] : MIDDLE, input.classId, 3);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль кэширования сервиса на Python 3. Время и источники данных классы и функции получают параметрами. ' +
				'Ключи кэшей и параметры, из которых они строятся, — строки или целые числа (не bool и не float); ' +
				'составные значения (списки, словари) в них не передаются. ' +
				'У каждого класса и функции в строке документации записан контракт; в модуле один дефект. ' +
				'Введите номер строки с дефектом (нумерация с 1). Если исправить можно в нескольких строках — засчитывается любая ' +
				'из них, где замена одной инструкцией Python (без `;`) восстанавливает спецификацию. Исправление — одна простая инструкция того же вида, что исправляемая строка: не добавляйте ' +
				'конструкций, которых в ней нет (`:=`, lambda, обёртки, новые функции), и не переносите в неё логику из другой строки.',
			code: { language: 'python3', source: p.source }
		},
		answer: {
			kind: 'line_no',
			value: p.answer,
			...(p.alternatives.length ? { alternatives: p.alternatives.map((a) => a.line) } : {})
		}
	});
	return {
		instance,
		reference: () => ({
			kind: 'bug',
			check: p.check,
			fix: p.fix,
			...(p.alternatives.length ? { alternatives: p.alternatives } : {})
		}),
		wrong: () => ({
			'neighbour-line': { kind: 'line', line: p.neighbour.line, replacement: p.neighbour.text },
			'other-unit': p.other.line === 0 ? null : { kind: 'line', line: p.other.line, replacement: p.other.text }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
