// Delegation and extensions in Kotlin: when `by lazy` computes (once, on the first access, again after an exception),
// what `Delegates.observable` and `Delegates.vetoable` report and refuse, that a delegate of `Repo by base` does not see
// the overrides of the delegating class and stays the object given at construction, that extension functions resolve
// by the declared type and lose to members, the order of companion objects, property initializers and `init` blocks
// across a base class and a subclass, and their sums with lazy and observable properties. The model executes the shown
// program. The mechanism that decides the output is the essential class; names, words and numbers are surface.
import {
	instanceRng,
	levelAndClass,
	readDescriptor,
	type Built,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { traceBuilt, type TraceProgram } from '../../_lib/kotlin-items.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const WORDS = ['home', 'feed', 'cart', 'chat', 'inbox', 'map', 'promo', 'news', 'store', 'deals'];

// Middle.

/** `by lazy`: computed on the first access only, a lazy reading another computes it; an exception leaves it uncomputed. */
function lazyInit(rng: Rng): TraceProgram {
	const cls = rng.pick(['ProfileScreen', 'ChatScreen', 'CartScreen']);
	const [p1, p2] = rng.sample(['avatar', 'banner', 'cover', 'header', 'caption', 'title'], 2) as [string, string];
	const id = rng.int(2, 99);
	const v1 = `${rng.pick(['img', 'pic', 'res'])}${id}`;
	const dependent = rng.bool(0.6);
	const withToken = rng.bool(0.5);
	const failures = rng.int(1, 2);
	type Access = 'p1' | 'p2' | 'token';
	const accesses: Access[] = rng.shuffle<Access>([
		'p1',
		'p2',
		rng.pick<Access>(['p1', 'p2']),
		...(withToken ? Array.from({ length: failures + rng.int(1, 2) }, (): Access => 'token') : [])
	]);
	const v2 = dependent ? `${v1}-${id}` : `${rng.pick(['t', 'h', 'c'])}${id}`;
	const screen = rng.pick(['screen', 'page', 'view']);
	const lines = [
		`class ${cls}(private val id: Int) {`,
		...(withToken ? ['    private var attempts = 0', ''] : []),
		'    init {',
		'        println("init $id")',
		'    }',
		'',
		`    val ${p1}: String by lazy {`,
		`        println("load ${p1}")`,
		`        "${v1.replace(String(id), '$id')}"`,
		'    }',
		'',
		`    val ${p2}: String by lazy {`,
		`        println("build ${p2}")`,
		dependent ? `        "\${${p1}}-$id"` : `        "${v2.replace(String(id), '$id')}"`,
		'    }',
		...(withToken
			? [
					'',
					'    val token: String by lazy {',
					'        attempts += 1',
					'        println("token $attempts")',
					`        if (attempts <= ${failures}) throw IllegalStateException("offline")`,
					'        "tok$attempts"',
					'    }'
				]
			: []),
		'}',
		'',
		'fun main() {',
		`    val ${screen} = ${cls}(${id})`,
		'    println("created")',
		...accesses.map((a) =>
			a === 'token'
				? `    try { println(${screen}.token) } catch (e: IllegalStateException) { println("failed") }`
				: `    println(${screen}.${a === 'p1' ? p1 : p2})`
		),
		'}'
	];
	type Mode = 'kotlin' | 'every-access' | 'eager' | 'caches-failure';
	const run = (mode: Mode): string[] => {
		const out: string[] = [`init ${id}`];
		let has1 = false;
		let has2 = false;
		let attempts = 0;
		let token: string | null = null;
		let failed = false;
		const get1 = (): string => {
			if (!has1 || mode === 'every-access') out.push(`load ${p1}`);
			has1 = true;
			return v1;
		};
		const get2 = (): string => {
			if (!has2 || mode === 'every-access') {
				out.push(`build ${p2}`);
				if (dependent) get1();
			}
			has2 = true;
			return v2;
		};
		if (mode === 'eager') {
			get1();
			get2();
		}
		out.push('created');
		for (const a of accesses) {
			if (a === 'p1') out.push(get1());
			else if (a === 'p2') out.push(get2());
			else if (token !== null && mode !== 'every-access') out.push(token);
			else if (failed && mode === 'caches-failure') out.push('failed');
			else {
				attempts += 1;
				out.push(`token ${attempts}`);
				if (attempts <= failures) {
					failed = true;
					out.push('failed');
				} else {
					token = `tok${attempts}`;
					out.push(token);
				}
			}
		}
		return out;
	};
	return {
		lines,
		answer: run('kotlin'),
		wrong: {
			'lazy-every-access': run('every-access'),
			'lazy-eager': withToken ? null : run('eager'),
			'lazy-caches-failure': withToken ? run('caches-failure') : null
		}
	};
}

/** `observable` reports every assignment, even of the same value; `vetoable` asks before and may keep the old value. */
function observableVetoable(rng: Rng): TraceProgram {
	for (;;) {
		const cls = rng.pick(['PlayerSettings', 'ChatSettings', 'MapSettings']);
		const [a, b] = rng.sample(['volume', 'zoom', 'speed', 'brightness', 'fontSize'], 2) as [string, string];
		const a0 = rng.int(1, 9);
		const b0 = rng.int(10, 60);
		const predKind = rng.int(0, 2);
		const pred =
			predKind === 0
				? { text: 'new in 0..100', ok: (_o: number, n: number) => n >= 0 && n <= 100 }
				: predKind === 1
					? { text: 'new > old', ok: (o: number, n: number) => n > o }
					: { text: 'new % 5 == 0', ok: (_o: number, n: number) => n % 5 === 0 };
		type Op = { prop: 'a' | 'b'; kind: 'set' | 'add'; value: number } | { prop: null };
		const ops: Op[] = [];
		const count = rng.int(5, 7);
		for (let i = 0; i < count; i += 1) {
			const r = rng.int(0, 9);
			if (r < 4) ops.push({ prop: 'a', kind: rng.bool(0.7) ? 'set' : 'add', value: rng.int(1, 12) });
			else if (r < 9)
				ops.push(
					rng.bool(0.7)
						? { prop: 'b', kind: 'set', value: rng.pick([-10, 120, 150, rng.int(0, 100), 5 * rng.int(0, 20)]) }
						: { prop: 'b', kind: 'add', value: rng.pick([-15, 5, 10, 7, 25]) }
				);
			else ops.push({ prop: null });
		}
		const settings = rng.pick(['settings', 'prefs', 'config']);
		const lines = [
			'import kotlin.properties.Delegates',
			'',
			`class ${cls} {`,
			`    var ${a}: Int by Delegates.observable(${a0}) { _, old, new ->`,
			`        println("${a} $old -> $new")`,
			'    }',
			`    var ${b}: Int by Delegates.vetoable(${b0}) { _, old, new ->`,
			`        println("check $old -> $new")`,
			`        ${pred.text}`,
			'    }',
			'}',
			'',
			'fun main() {',
			`    val ${settings} = ${cls}()`,
			...ops.map((op) =>
				op.prop === null
					? `    println("now \${${settings}.${a}} \${${settings}.${b}}")`
					: `    ${settings}.${op.prop === 'a' ? a : b} ${op.kind === 'set' ? '=' : '+='} ${op.value}`
			),
			`    println("final \${${settings}.${a}} \${${settings}.${b}}")`,
			'}'
		];
		const run = (skipsEqual: boolean, vetoIgnored: boolean): { out: string[]; equal: boolean; veto: boolean } => {
			const out: string[] = [];
			let va = a0;
			let vb = b0;
			let equal = false;
			let veto = false;
			for (const op of ops) {
				if (op.prop === null) out.push(`now ${va} ${vb}`);
				else if (op.prop === 'a') {
					const next = op.kind === 'set' ? op.value : va + op.value;
					if (next === va) equal = true;
					if (!(skipsEqual && next === va)) out.push(`${a} ${va} -> ${next}`);
					va = next;
				} else {
					const next = op.kind === 'set' ? op.value : vb + op.value;
					out.push(`check ${vb} -> ${next}`);
					if (pred.ok(vb, next) || vetoIgnored) vb = next;
					else veto = true;
				}
			}
			out.push(`final ${va} ${vb}`);
			return { out, equal, veto };
		};
		const right = run(false, false);
		// The program must assign an equal value once and have a refused assignment.
		if (!right.equal || !right.veto) continue;
		return {
			lines,
			answer: right.out,
			wrong: {
				'observable-skips-equal': run(true, false).out,
				'veto-ignored': run(false, true).out
			}
		};
	}
}

/** `Repo by base`: the delegate runs its own methods; its internal calls do not see the overrides of the wrapper. */
function interfaceDelegation(rng: Rng): TraceProgram {
	for (;;) {
		const [iface, base, wrapper] = rng.pick([
			['Repo', 'RemoteRepo', 'CachedRepo'],
			['Source', 'NetworkSource', 'OfflineSource'],
			['Store', 'DiskStore', 'MemoryStore']
		] as const);
		const key = rng.pick(['origin', 'tag', 'name']);
		const load = rng.pick(['load', 'fetch', 'read']);
		const describe = rng.pick(['describe', 'info', 'summary']);
		const baseKey = rng.pick(['remote', 'net', 'disk']);
		const wrapKey = rng.pick(['cache', 'memory', 'local']);
		const describeOverride = rng.int(0, 2); // 0 — none, 1 — wrapper's key, 2 — base's describe
		const ids = [rng.int(1, 9), rng.int(10, 99)];
		type Call = { target: 'wrap' | 'base'; method: 'key' | 'load' | 'describe'; arg: number };
		const calls: Call[] = rng.shuffle<Call>([
			{ target: 'wrap', method: 'key', arg: 0 },
			{ target: 'wrap', method: 'load', arg: ids[0] as number },
			{ target: 'wrap', method: 'describe', arg: 0 },
			rng.bool()
				? { target: 'base', method: 'load', arg: ids[1] as number }
				: { target: 'base', method: 'describe', arg: 0 }
		]);
		const [repo, remote] = rng.pick([
			['repo', 'remote'],
			['source', 'origin'],
			['store', 'backing']
		] as const);
		if (remote === key || repo === key) continue;
		const lines = [
			`interface ${iface} {`,
			`    fun ${key}(): String`,
			`    fun ${load}(id: Int): String`,
			`    fun ${describe}(): String`,
			'}',
			'',
			`class ${base} : ${iface} {`,
			`    override fun ${key}() = "${baseKey}"`,
			`    override fun ${load}(id: Int) = "\${${key}()}:$id"`,
			`    override fun ${describe}() = "${iface.toLowerCase()} \${${key}()}"`,
			'}',
			'',
			`class ${wrapper}(private val base: ${iface}) : ${iface} by base {`,
			`    override fun ${key}() = "${wrapKey}"`,
			...(describeOverride === 1 ? [`    override fun ${describe}() = "wrapped \${${key}()}"`] : []),
			...(describeOverride === 2 ? [`    override fun ${describe}() = "wrapped \${base.${describe}()}"`] : []),
			'}',
			'',
			'fun main() {',
			`    val ${remote} = ${base}()`,
			`    val ${repo}: ${iface} = ${wrapper}(${remote})`,
			...calls.map((c) => {
				const name = c.method === 'key' ? key : c.method === 'load' ? load : describe;
				return `    println(${c.target === 'wrap' ? repo : remote}.${name}(${c.method === 'load' ? c.arg : ''}))`;
			}),
			'}'
		];
		type Mode = 'kotlin' | 'sees-override' | 'override-ignored';
		const run = (mode: Mode): string[] =>
			calls.map((c) => {
				const viaWrapper = c.target === 'wrap' && mode !== 'override-ignored';
				// The key the base's own methods see: its own, unless the misconception routes them to the wrapper.
				const innerKey = c.target === 'wrap' && mode === 'sees-override' ? wrapKey : baseKey;
				const baseDescribe = `${iface.toLowerCase()} ${innerKey}`;
				if (c.method === 'key') return viaWrapper ? wrapKey : baseKey;
				if (c.method === 'load')
					return `${c.target === 'wrap' && mode !== 'override-ignored' ? innerKey : baseKey}:${c.arg}`;
				if (viaWrapper && describeOverride === 1) return `wrapped ${wrapKey}`;
				if (viaWrapper && describeOverride === 2) return `wrapped ${iface.toLowerCase()} ${baseKey}`;
				return c.target === 'wrap' && mode !== 'override-ignored' ? baseDescribe : `${iface.toLowerCase()} ${baseKey}`;
			});
		return {
			lines,
			answer: run('kotlin'),
			wrong: { 'delegate-sees-override': run('sees-override'), 'override-ignored': run('override-ignored') }
		};
	}
}

/** Extensions resolve by the declared type, members by the object; a member wins over an extension of the same name. */
function extensionStatic(rng: Rng): TraceProgram {
	const [parent, child] = rng.pick([
		['View', 'Button'],
		['Message', 'ImageMessage'],
		['Screen', 'HomeScreen'],
		['Card', 'PromoCard']
	] as const);
	const kind = rng.pick(['kind', 'type', 'role']);
	const ext = rng.pick(['describe', 'render', 'badge']);
	const member = rng.pick(['label', 'caption', 'hint']);
	const n = rng.int(1, 9);
	const w = {
		pKind: `${parent.toLowerCase()} ${n}`,
		cKind: `${child.toLowerCase()} ${n}`,
		pExt: `ext ${parent.toLowerCase()}`,
		cExt: `ext ${child.toLowerCase()}`,
		member: `member ${member}`,
		extMember: `ext ${member}`
	};
	const [a, b] = rng.pick([
		['button', 'view'],
		['item', 'base'],
		['concrete', 'general']
	] as const);
	type Call = 'aExt' | 'bExt' | 'aKind' | 'bKind' | 'aMember' | 'list' | 'cast';
	const extra = rng.sample<Call>(['aKind', 'list', 'cast'], 2);
	// `b as Child` smart-casts `b` for the rest of main: the cast goes last.
	const calls = [
		...rng.shuffle<Call>(['aExt', 'bExt', 'bKind', 'aMember', ...extra.filter((c) => c !== 'cast')]),
		...extra.filter((c) => c === 'cast')
	];
	const lines = [
		`open class ${parent} {`,
		`    open fun ${kind}() = "${parent.toLowerCase()} ${n}"`,
		'}',
		'',
		`class ${child} : ${parent}() {`,
		`    override fun ${kind}() = "${child.toLowerCase()} ${n}"`,
		`    fun ${member}() = "member ${member}"`,
		'}',
		'',
		`fun ${parent}.${ext}() = "ext ${parent.toLowerCase()}"`,
		`fun ${child}.${ext}() = "ext ${child.toLowerCase()}"`,
		`fun ${child}.${member}() = "ext ${member}"`,
		'',
		'fun main() {',
		`    val ${a} = ${child}()`,
		`    val ${b}: ${parent} = ${a}`,
		...calls.map((c) => {
			switch (c) {
				case 'aExt':
					return `    println(${a}.${ext}())`;
				case 'bExt':
					return `    println(${b}.${ext}())`;
				case 'aKind':
					return `    println(${a}.${kind}())`;
				case 'bKind':
					return `    println(${b}.${kind}())`;
				case 'aMember':
					return `    println(${a}.${member}())`;
				case 'list':
					return `    listOf(${parent}(), ${a}).forEach { println(it.${ext}()) }`;
				case 'cast':
					return `    println((${b} as ${child}).${ext}())`;
			}
		}),
		'}'
	];
	const run = (dynamic: boolean, extBeats: boolean): string[] =>
		calls.flatMap((c) => {
			switch (c) {
				case 'aExt':
				case 'cast':
					return [w.cExt];
				case 'bExt':
					return [dynamic ? w.cExt : w.pExt];
				case 'aKind':
				case 'bKind':
					return [w.cKind];
				case 'aMember':
					return [extBeats ? w.extMember : w.member];
				case 'list':
					return [w.pExt, dynamic ? w.cExt : w.pExt];
			}
		});
	return {
		lines,
		answer: run(false, false),
		wrong: { 'extension-dynamic': run(true, false), 'extension-beats-member': run(false, true) }
	};
}

// Senior.

/** Companions once, base before subclass, initializers and `init` in text order; an override called from the base sees defaults. */
function initOrder(rng: Rng): TraceProgram {
	const [base, sub] = rng.pick([
		['BaseScreen', 'HomeScreen'],
		['BaseFragment', 'CartFragment'],
		['BaseActivity', 'ChatActivity']
	] as const);
	const name = rng.pick(WORDS);
	const title = rng.pick(['Inbox', 'Orders', 'Promo', 'Saved']);
	const count = rng.int(2, 9);
	const baseCompanion = rng.bool(0.5);
	const subCompanion = rng.bool(0.7) || !baseCompanion;
	const subCallsSetup = rng.bool(0.4);
	type BaseItem = 'init' | 'prop' | 'setup';
	const baseItems = rng.shuffle<BaseItem>(['init', 'prop', 'setup']);
	const constructions = rng.int(2, 3);
	const lines = [
		`open class ${base}(val name: String) {`,
		...baseItems.map((item) =>
			item === 'init'
				? '    init { println("base init $name") }'
				: item === 'prop'
					? '    val created = log("base prop")'
					: '    init { setup() }'
		),
		'    open fun setup() { println("base setup") }',
		'    fun log(s: String): String { println(s); return s }',
		...(baseCompanion ? ['    companion object { init { println("base companion") } }'] : []),
		'}',
		'',
		`class ${sub} : ${base}("${name}") {`,
		`    val title = "${title}"`,
		`    var count = ${count}`,
		'    init { println("sub init $title $count") }',
		'    override fun setup() { println("sub setup $title $count") }',
		...(subCallsSetup ? ['    init { setup() }'] : []),
		...(subCompanion ? ['    companion object { init { println("sub companion") } }'] : []),
		'}',
		'',
		'fun main() {',
		'    println("start")',
		...Array.from({ length: constructions }, (_, i) => [`    ${sub}()`, `    println("built ${i + 1}")`]).flat(),
		'}'
	];
	type Mode = 'kotlin' | 'derived-first' | 'sees-initialized' | 'companion-per-instance';
	const run = (mode: Mode): string[] => {
		const out = ['start'];
		for (let i = 0; i < constructions; i += 1) {
			if (i === 0 || mode === 'companion-per-instance') {
				if (baseCompanion) out.push('base companion');
				if (subCompanion) out.push('sub companion');
			}
			const ready = { value: false };
			const setupLine = (): string =>
				ready.value || mode === 'sees-initialized' ? `sub setup ${title} ${count}` : 'sub setup null 0';
			const baseBody = (): void => {
				for (const item of baseItems) {
					if (item === 'init') out.push(`base init ${name}`);
					else if (item === 'prop') out.push('base prop');
					else out.push(setupLine());
				}
			};
			const subBody = (): void => {
				ready.value = true;
				out.push(`sub init ${title} ${count}`);
				if (subCallsSetup) out.push(setupLine());
			};
			if (mode === 'derived-first') {
				subBody();
				baseBody();
			} else {
				baseBody();
				subBody();
			}
			out.push(`built ${i + 1}`);
		}
		return out;
	};
	return {
		lines,
		answer: run('kotlin'),
		wrong: {
			'derived-first': run('derived-first'),
			'override-sees-initialized': run('sees-initialized'),
			'companion-per-instance': run('companion-per-instance')
		}
	};
}

/** A lazy read during construction caches what it saw; observable reports assignments in `init`, not the initial value. */
function lazyDelegateCombo(rng: Rng): TraceProgram {
	const cls = rng.pick(['Player', 'Account', 'Level']);
	const prop = rng.pick(['level', 'score', 'stage']);
	const lazyName = rng.pick(['badge', 'summary', 'title']);
	const later = rng.pick(['rank', 'tier', 'weight']);
	const start = rng.int(1, 9);
	const d = rng.int(1, 5);
	const m = rng.int(2, 9);
	const x = rng.int(10, 30);
	const y = rng.int(31, 60);
	const early = rng.bool(0.65);
	const reportRank = rng.bool();
	const tag = rng.pick(['L', 'P', 'S']);
	const obj = rng.pick(['p', 'hero', 'model']);
	const lines = [
		'import kotlin.properties.Delegates',
		'',
		`class ${cls}(start: Int) {`,
		`    var ${prop}: Int by Delegates.observable(start) { _, old, new ->`,
		`        println("${prop} $old -> $new")`,
		'    }',
		`    val ${lazyName}: String by lazy {`,
		`        println("${lazyName}")`,
		`        "${tag}$${prop}/$${later}"`,
		'    }',
		'',
		'    init {',
		`        ${prop} += ${d}`,
		...(early ? [`        println("init $${lazyName}")`] : []),
		'    }',
		`    val ${later} = ${prop} * ${m}`,
		'',
		'    init {',
		`        ${prop} = ${x}`,
		...(reportRank ? [`        println("${later} $${later}")`] : []),
		'    }',
		'}',
		'',
		'fun main() {',
		`    val ${obj} = ${cls}(${start})`,
		'    println("created")',
		`    println(${obj}.${lazyName})`,
		`    ${obj}.${prop} = ${y}`,
		`    println(${obj}.${lazyName})`,
		`    println("${later} \${${obj}.${later}}")`,
		'}'
	];
	type Mode = 'kotlin' | 'final-state' | 'recomputes' | 'skips-init';
	const run = (mode: Mode): string[] => {
		const out: string[] = [];
		let value = start;
		let laterValue = 0;
		const finalLater = (start + d) * m;
		let cached: string | null = null;
		const set = (next: number, inInit: boolean): void => {
			if (!(inInit && mode === 'skips-init')) out.push(`${prop} ${value} -> ${next}`);
			value = next;
		};
		const read = (): string => {
			if (cached !== null && mode !== 'recomputes') return cached;
			out.push(lazyName);
			cached = `${tag}${value}/${mode === 'final-state' ? finalLater : laterValue}`;
			return cached;
		};
		set(start + d, true);
		if (early) out.push(`init ${read()}`);
		laterValue = value * m;
		set(x, true);
		if (reportRank) out.push(`${later} ${laterValue}`);
		out.push('created');
		out.push(read());
		set(y, false);
		out.push(read());
		out.push(`${later} ${laterValue}`);
		return out;
	};
	return {
		lines,
		answer: run('kotlin'),
		wrong: {
			'lazy-sees-final-state': early ? run('final-state') : null,
			'lazy-every-access': run('recomputes'),
			'observable-skips-init': run('skips-init')
		}
	};
}

/** An extension on a nullable receiver is called on null, unless a safe call skips it; static types pick the extension. */
function nullableReceiver(rng: Rng): TraceProgram {
	const orName = rng.pick(['orDash', 'orPlaceholder', 'orBlank']);
	const placeholder = rng.pick(['-', 'n/a', '?']);
	const info = rng.pick(['describe', 'info', 'debug']);
	const tagCls = rng.pick(['Tag', 'Chip', 'Badge']);
	const word = rng.pick(WORDS);
	const word2 = rng.pick(WORDS.filter((w) => w !== word));
	const tagWord = rng.pick(['new', 'hot', 'sale']);
	const none = rng.pick(['none', 'empty', 'unset']);
	type Stmt =
		'nullExt' | 'nullSafe' | 'nullSafeElvis' | 'emptyExt' | 'anyInfo' | 'strInfo' | 'maybeInfo' | 'nilInfo' | 'member';
	const stmts = rng.shuffle<Stmt>([
		'nullExt',
		'nullSafe',
		'anyInfo',
		'maybeInfo',
		'member',
		...rng.sample<Stmt>(['nullSafeElvis', 'emptyExt', 'strInfo', 'nilInfo'], 2)
	]);
	const lines = [
		`fun String?.${orName}(): String = if (this.isNullOrEmpty()) "${placeholder}" else this`,
		`fun Any?.${info}(): String = "any:" + (this?.toString() ?: "nil")`,
		`fun String.${info}(): String = "str:$this"`,
		'',
		`class ${tagCls}(val name: String) {`,
		`    fun ${info}() = "member:$name"`,
		'}',
		`fun ${tagCls}.${info}(): String = "ext:$name"`,
		'',
		'fun main() {',
		'    val raw: String? = null',
		'    val empty = ""',
		`    val any: Any = "${word}"`,
		`    val text = "${word2}"`,
		`    val maybe: String? = "${word2}"`,
		'    val nothing: String? = null',
		...stmts.map((s) => {
			switch (s) {
				case 'nullExt':
					return `    println(raw.${orName}())`;
				case 'nullSafe':
					return `    println(raw?.${orName}())`;
				case 'nullSafeElvis':
					return `    println(raw?.${orName}() ?: "${none}")`;
				case 'emptyExt':
					return `    println(empty.${orName}())`;
				case 'anyInfo':
					return `    println(any.${info}())`;
				case 'strInfo':
					return `    println(text.${info}())`;
				case 'maybeInfo':
					return `    println(maybe.${info}())`;
				case 'nilInfo':
					return `    println(nothing.${info}())`;
				case 'member':
					return `    println(${tagCls}("${tagWord}").${info}())`;
			}
		}),
		'}'
	];
	type Mode = 'kotlin' | 'safe-runs' | 'dynamic' | 'ext-beats';
	const run = (mode: Mode): string[] =>
		stmts.map((s) => {
			switch (s) {
				case 'nullExt':
				case 'emptyExt':
					return placeholder;
				case 'nullSafe':
					return mode === 'safe-runs' ? placeholder : 'null';
				case 'nullSafeElvis':
					return mode === 'safe-runs' ? placeholder : none;
				case 'anyInfo':
					return mode === 'dynamic' ? `str:${word}` : `any:${word}`;
				case 'strInfo':
					return `str:${word2}`;
				case 'maybeInfo':
					return mode === 'dynamic' ? `str:${word2}` : `any:${word2}`;
				case 'nilInfo':
					return 'any:nil';
				case 'member':
					return mode === 'ext-beats' ? `ext:${tagWord}` : `member:${tagWord}`;
			}
		});
	return {
		lines,
		answer: run('kotlin'),
		wrong: {
			'safe-call-runs-extension': run('safe-runs'),
			'extension-dynamic': run('dynamic'),
			'extension-beats-member': run('ext-beats')
		}
	};
}

/** `by feed` takes the object given at construction: reassigning the property does not move the delegation. */
function delegateReassign(rng: Rng): TraceProgram {
	const [iface, impl, wrapper] = rng.pick([
		['Feed', 'RemoteFeed', 'FeedScreen'],
		['Banner', 'PromoBanner', 'BannerSlot'],
		['Player', 'StreamPlayer', 'PlayerView']
	] as const);
	const title = rng.pick(['title', 'name', 'label']);
	const render = rng.pick(['render', 'draw', 'show']);
	const prefix = rng.pick(['remote', 'net', 'live']);
	const own = rng.pick(['screen', 'slot', 'view']);
	const [t1, t2] = rng.sample(['a', 'b', 'c', 'x', 'y', 'z'], 2) as [string, string];
	const header = rng.pick(['header', 'caption', 'top']);
	const prop = rng.pick(['feed', 'source', 'current']);
	type Stmt = 'render' | 'propRender' | 'title' | 'header';
	const before = rng.shuffle<Stmt>(['render', rng.pick<Stmt>(['title', 'header'])]);
	const after = rng.shuffle<Stmt>(['render', 'propRender', 'header', ...(rng.bool() ? (['title'] as Stmt[]) : [])]);
	const s = rng.pick(['w', 'slot', 'holder']);
	const stmtLine = (st: Stmt): string =>
		st === 'render'
			? `    println(${s}.${render}())`
			: st === 'propRender'
				? `    println(${s}.${prop}.${render}())`
				: st === 'title'
					? `    println(${s}.${title}())`
					: `    println(${s}.${header}())`;
	const lines = [
		`interface ${iface} {`,
		`    fun ${title}(): String`,
		`    fun ${render}(): String`,
		'}',
		'',
		`class ${impl}(private val tag: String) : ${iface} {`,
		`    override fun ${title}() = "${prefix}-$tag"`,
		`    override fun ${render}() = "[\${${title}()}]"`,
		'}',
		'',
		`class ${wrapper}(var ${prop}: ${iface}) : ${iface} by ${prop} {`,
		`    override fun ${title}() = "${own}"`,
		`    fun ${header}() = "h:\${${prop}.${title}()}"`,
		'}',
		'',
		'fun main() {',
		`    val ${s} = ${wrapper}(${impl}("${t1}"))`,
		...before.map(stmtLine),
		`    ${s}.${prop} = ${impl}("${t2}")`,
		...after.map(stmtLine),
		'}'
	];
	type Mode = 'kotlin' | 'follows' | 'sees-override';
	const run = (mode: Mode): string[] => {
		const out: string[] = [];
		let current = t1;
		const delegate = t1;
		const emit = (st: Stmt): void => {
			const d = mode === 'follows' ? current : delegate;
			if (st === 'render') out.push(mode === 'sees-override' ? `[${own}]` : `[${prefix}-${d}]`);
			else if (st === 'propRender') out.push(`[${prefix}-${current}]`);
			else if (st === 'title') out.push(own);
			else out.push(`h:${prefix}-${current}`);
		};
		before.forEach(emit);
		current = t2;
		after.forEach(emit);
		return out;
	};
	return {
		lines,
		answer: run('kotlin'),
		wrong: { 'delegate-follows-property': run('follows'), 'delegate-sees-override': run('sees-override') }
	};
}

const PROGRAMS: Readonly<Record<string, (rng: Rng) => TraceProgram>> = {
	'lazy-init': lazyInit,
	'observable-vetoable': observableVetoable,
	'interface-delegation': interfaceDelegation,
	'extension-static': extensionStatic,
	'init-order': initOrder,
	'lazy-delegate-combo': lazyDelegateCombo,
	'nullable-receiver': nullableReceiver,
	'delegate-reassign': delegateReassign
};

// The output depends on the platform (values of fields read before their initializers run differ on Kotlin/JS), so
// the statement names the runtime the answer is computed for.
const STATEMENT =
	'Что напечатает программа на Kotlin 2.4 (Kotlin/JVM, JVM 21)? Введите вывод построчно, как он появится на экране.';

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const make = PROGRAMS[input.classId];
	if (!make) throw new Error(`no program for ${input.classId}`);
	const built = traceBuilt(descriptor, input, make(instanceRng(descriptor, input)));
	const { instance } = built;
	return { ...built, instance: { ...instance, statement: { ...instance.statement, markdown: STATEMENT } } };
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
