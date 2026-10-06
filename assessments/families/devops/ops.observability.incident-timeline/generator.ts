// An incident from the journals of several services and the alerts of monitoring, with the graph of dependencies: the
// root cause (a failed service whose dependencies never failed, the earliest of such), the time to detect and the time
// to recover by the definitions of the statement. Senior adds a host with a skewed clock, two independent failures and
// silent chains where the first error names an intermediate service.
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

type Level = 'INFO' | 'WARN' | 'ERROR' | 'ALERT';

interface Entry {
	/** Real moment, seconds from midnight. */
	real: number;
	service: string;
	level: Level;
	text: string;
	/** ERROR of a dependent: the dependency it names. */
	upstream: string | null;
	/** ALERT: the service it is about. */
	about: string | null;
}

interface Params {
	deps: Record<string, string[]>;
	order: string[];
	/** Host clock offset per service: its entries are stamped `real + skew`. */
	skew: Record<string, number>;
	entries: Entry[];
}

interface Rules {
	earliestErrorRoot: boolean;
	firstAlertRoot: boolean;
	namedUpstreamRoot: boolean;
	mttdFromRoot: boolean;
	mttrFromAlert: boolean;
	mttrRootOnly: boolean;
	firstRecovery: boolean;
	warnAsError: boolean;
	skewIgnored: boolean;
}

const RIGHT: Rules = {
	earliestErrorRoot: false,
	firstAlertRoot: false,
	namedUpstreamRoot: false,
	mttdFromRoot: false,
	mttrFromAlert: false,
	mttrRootOnly: false,
	firstRecovery: false,
	warnAsError: false,
	skewIgnored: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'earliest-error-root': { earliestErrorRoot: true },
	'first-alert-root': { firstAlertRoot: true },
	'named-upstream-root': { namedUpstreamRoot: true },
	'mttd-from-root': { mttdFromRoot: true },
	'mttr-from-alert': { mttrFromAlert: true },
	'mttr-root-only': { mttrRootOnly: true },
	'first-recovery': { firstRecovery: true },
	'warn-as-error': { warnAsError: true },
	'skew-ignored': { skewIgnored: true }
};

const shownAt = (p: Params, e: Entry): number => e.real + (p.skew[e.service] ?? 0);

/** The answer `<root> <MTTD> <MTTR>` read off the entries under the rules. */
function analyse(p: Params, rules: Rules): string {
	const at = (e: Entry): number => (rules.skewIgnored ? shownAt(p, e) : e.real);
	const sorted = [...p.entries].sort((a, b) => at(a) - at(b));
	const firstError = new Map<string, number>();
	const firstRecovered = new Map<string, number>();
	const finalRecovered = new Map<string, number>();
	const failing = new Map<string, boolean>();
	let start = Infinity;
	let alert = Infinity;
	let alertAbout = '';
	let earliest: Entry | null = null;
	for (const e of sorted) {
		const t = at(e);
		if (e.level === 'ALERT') {
			if (t < alert) {
				alert = t;
				alertAbout = e.about ?? '';
			}
			continue;
		}
		if (e.level === 'WARN' && rules.warnAsError) start = Math.min(start, t);
		if (e.level === 'ERROR') {
			if (!firstError.has(e.service)) firstError.set(e.service, t);
			if (earliest === null || t < at(earliest)) earliest = e;
			start = Math.min(start, t);
			failing.set(e.service, true);
		}
		if (e.level === 'INFO' && e.text.startsWith('recovered') && failing.get(e.service)) {
			failing.set(e.service, false);
			if (!firstRecovered.has(e.service)) firstRecovered.set(e.service, t);
			finalRecovered.set(e.service, t);
		}
	}
	const failed = [...firstError.keys()];
	const byStart = (a: string, b: string): number => (firstError.get(a) ?? 0) - (firstError.get(b) ?? 0);
	const candidates = failed.filter((s) => (p.deps[s] ?? []).every((d) => !firstError.has(d))).sort(byStart);
	let root = candidates[0] ?? '?';
	if (rules.earliestErrorRoot) root = [...failed].sort(byStart)[0] ?? '?';
	if (rules.firstAlertRoot) root = alertAbout;
	if (rules.namedUpstreamRoot && earliest) root = earliest.upstream ?? earliest.service;
	const recoveredAt = (s: string): number =>
		(rules.firstRecovery ? firstRecovered.get(s) : finalRecovered.get(s)) ?? Infinity;
	const end = rules.mttrRootOnly ? recoveredAt(root) : Math.max(...failed.map(recoveredAt));
	const mttd = alert - (rules.mttdFromRoot ? (firstError.get(root) ?? start) : start);
	const mttr = end - (rules.mttrFromAlert ? alert : start);
	return `${root} ${mttd} ${mttr}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const TOP = ['web', 'gateway', 'mobile-bff', 'frontend', 'edge'];
const MID = ['api', 'orders', 'cart', 'checkout', 'search', 'catalog', 'pricing', 'auth', 'stock', 'payments'];
const LEAF = ['db', 'cache', 'ledger', 'queue', 'object-store', 'session-store'];
const ROOT_TEXTS = [
	'connection pool exhausted',
	'disk full: /var/lib/data',
	'worker killed: out of memory',
	'TLS certificate expired',
	'deadlock detected, transaction aborted',
	'too many open files'
];
const WARN_TEXTS = ['slow query: 2.4s', 'gc pause 900ms', 'queue lag 1200 messages', 'retrying request (1/3)'];
const NOISE = ['request served in 41ms', 'config reloaded', 'cache hit ratio 0.93', 'scheduled job done'];

function graph(rng: Rng, grade: string): { deps: Record<string, string[]>; order: string[] } {
	if (grade === 'middle') {
		const f = rng.pick(TOP);
		const [a, s1, s2] = rng.sample(MID, 3) as [string, string, string];
		const l1 = rng.pick(LEAF);
		return { deps: { [f]: [a], [a]: [s1, s2], [s1]: [l1], [s2]: [], [l1]: [] }, order: [f, a, s1, s2, l1] };
	}
	const f = rng.pick(TOP);
	const [a, b, c, e] = rng.sample(MID, 4) as [string, string, string, string];
	const [d, g] = rng.sample(LEAF, 2) as [string, string];
	return {
		deps: { [f]: [a], [a]: [b, e], [b]: [c], [c]: [d], [d]: [], [e]: [g], [g]: [] },
		order: [f, a, b, c, d, e, g]
	};
}

/** Every service that depends on `s`, with its distance and the dependency it goes through. */
function ancestors(deps: Record<string, string[]>, s: string): { service: string; depth: number; via: string }[] {
	const out: { service: string; depth: number; via: string }[] = [];
	let frontier = [{ service: s, depth: 0 }];
	while (frontier.length) {
		const next: { service: string; depth: number }[] = [];
		for (const node of frontier) {
			for (const [svc, list] of Object.entries(deps)) {
				if (list.includes(node.service) && !out.some((o) => o.service === svc)) {
					out.push({ service: svc, depth: node.depth + 1, via: node.service });
					next.push({ service: svc, depth: node.depth + 1 });
				}
			}
		}
		frontier = next;
	}
	return out;
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const { deps, order } = graph(rng, grade);
	const entries: Entry[] = [];
	const base = rng.int(1, 20) * 3600 + rng.int(0, 59) * 60;
	const log = (real: number, service: string, level: Level, text: string, upstream: string | null = null): void => {
		entries.push({ real: base + real, service, level, text, upstream, about: null });
	};
	const leaves = order.filter((s) => (deps[s] ?? []).length === 0);
	const pickRoot = (): string => {
		if (classId === 'deep-chain') return order[4] ?? '';
		if (grade === 'middle') return rng.pick([...leaves, order[2] ?? '']);
		return rng.pick([...leaves, order[3] ?? '', order[5] ?? '']);
	};
	const roots = [pickRoot()];
	if (classId === 'two-candidates') {
		const other = order.filter(
			(s) =>
				s !== roots[0] &&
				!ancestors(deps, roots[0] ?? '').some((a) => a.service === s) &&
				!ancestors(deps, s).some((a) => a.service === roots[0]) &&
				ancestors(deps, s).length > 0 &&
				(deps[s] ?? []).every((d) => d !== roots[0])
		);
		if (other.length) roots.push(rng.pick(other));
	}
	const silent = classId === 'silent-root' || classId === 'clock-skew' || classId === 'deep-chain';
	const affected = new Map<string, { first: number; rec: number; via: string }>();
	roots.forEach((root, ri) => {
		const r0 = ri === 0 ? 0 : rng.int(20, 200);
		const rootFirst = r0 + (silent && ri === 0 ? rng.int(90, 240) : rng.int(0, 15));
		const rr = r0 + rng.int(600, 2400);
		log(rootFirst, root, 'ERROR', rng.pick(ROOT_TEXTS));
		log(rr, root, 'INFO', 'recovered: health check passing');
		for (const u of ancestors(deps, root)) {
			let first = r0 + u.depth * rng.int(5, 40);
			if (classId === 'deep-chain' && u.depth === 1) first = rootFirst + rng.int(5, 60);
			let rec = rr + u.depth * rng.int(5, 60);
			if (classId === 'slow-recovery' && u.depth === 1) rec = rr + rng.int(300, 900);
			const known = affected.get(u.service);
			affected.set(u.service, {
				first: Math.min(first, known?.first ?? first),
				rec: Math.max(rec, known?.rec ?? rec),
				via: known && known.first <= first ? known.via : u.via
			});
		}
	});
	const flapper = classId === 'flapping' || classId === 'skew-flap' ? rng.pick([...affected.keys()]) : null;
	for (const [service, a] of affected) {
		const why = (): string => rng.pick(['timeout after 5s', '503 Service Unavailable', 'connection refused']);
		log(a.first, service, 'ERROR', `upstream ${a.via}: ${why()}`, a.via);
		log(a.first + rng.int(20, 200), service, 'ERROR', `upstream ${a.via}: ${why()}`, a.via);
		log(a.rec, service, 'INFO', 'recovered: health check passing');
		if (service === flapper) {
			const again = a.rec + rng.int(30, 120);
			log(again, service, 'ERROR', 'readiness check failed after restart');
			log(again + rng.int(60, 600), service, 'INFO', 'recovered: health check passing');
		}
	}
	const affectedAll = new Set(affected.keys());
	const errors = entries.filter((e) => e.level === 'ERROR').map((e) => e.real - base);
	const incident = Math.min(...errors);
	const top = order[0] ?? '';
	const alertAbout = rng.pick([top, order[1] ?? top]);
	entries.push({
		real: base + incident + rng.int(30, 400),
		service: 'monitoring',
		level: 'ALERT',
		text: `HighErrorRate firing service=${alertAbout}`,
		upstream: null,
		about: alertAbout
	});
	if (classId === 'noisy-warn' || rng.bool(0.3)) {
		const r = roots[0] ?? '';
		log(incident - rng.int(30, 300), r, 'WARN', rng.pick(WARN_TEXTS));
	}
	const healthy = order.filter((s) => !roots.includes(s) && !affectedAll.has(s));
	for (const s of healthy) log(incident + rng.int(-300, 900), s, 'INFO', rng.pick(NOISE));
	const skew: Record<string, number> = {};
	if (classId === 'clock-skew' || classId === 'skew-flap') {
		const failed = [...new Set(entries.filter((e) => e.level === 'ERROR').map((e) => e.service))];
		skew[rng.pick(failed)] = rng.pick([-1, 1]) * rng.int(20, 120);
	}
	return { deps, order, skew, entries };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (s: number): string => `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;

function journal(p: Params): string[] {
	return [...p.entries]
		.sort((a, b) => shownAt(p, a) - shownAt(p, b) || a.service.localeCompare(b.service))
		.map((e) => `${clock(shownAt(p, e))} ${e.service} ${e.level} ${e.text}`);
}

function describe(p: Params): string {
	const depLines = p.order.map((s) => {
		const list = p.deps[s] ?? [];
		return `- \`${s}\` → ${list.length ? list.map((d) => `\`${d}\``).join(', ') : 'нет зависимостей'}`;
	});
	const skewed = Object.entries(p.skew);
	const lines = [
		'Сводный журнал сервисов и мониторинга за время инцидента. Зависимости (сервис → от кого он зависит):',
		'',
		...depLines,
		'',
		'Определения:',
		'',
		'- сервис **в отказе** с записи `ERROR` в его журнале до следующей его записи `INFO recovered`; `ERROR` после восстановления — новый отказ; `WARN` и прочие записи отказом не считаются;',
		'- **первопричина** — сервис, который был в отказе, а все его прямые зависимости за всё время журнала ни разу не были в отказе; если таких несколько — тот, чей первый отказ начался раньше;',
		'- **начало инцидента** — самая ранняя запись `ERROR` любого сервиса; **MTTD** — время от начала инцидента до первого оповещения (`ALERT`) мониторинга; **MTTR** — время от начала инцидента до момента, после которого ни один сервис больше не в отказе.'
	];
	if (skewed.length) {
		const [svc, k] = skewed[0] ?? ['', 0];
		lines.push(
			'',
			`Часы на хосте \`${svc}\` ${k > 0 ? 'спешат' : 'отстают'} на ${Math.abs(k)} с: его записи помечены на ${Math.abs(k)} с ${k > 0 ? 'позже' : 'раньше'} реального момента. Часы остальных хостов и мониторинга точны; журнал упорядочен по меткам времени как есть.`
		);
	}
	lines.push(
		'',
		'```',
		...journal(p),
		'```',
		'',
		'Введите через пробел имя сервиса-первопричины, MTTD и MTTR в секундах, например: `payments 95 1260`.'
	);
	return lines.join('\n');
}

// An independent reference: reads the shown journal, corrects the skewed host and applies the definitions.
const PYTHON_REFERENCE = `import json

data = json.loads(input())
deps = data["deps"]
skew = data["skew"]
events = []
for line in data["journal"]:
    stamp, service, level, text = line.split(" ", 3)
    h, m, s = map(int, stamp.split(":"))
    events.append((h * 3600 + m * 60 + s - skew.get(service, 0), service, level, text))
events.sort(key=lambda e: e[0])
state = {}
first_error = {}
last_recovery = {}
start = None
alert = None
for t, service, level, text in events:
    if level == "ALERT":
        alert = t if alert is None else min(alert, t)
    elif level == "ERROR":
        state[service] = True
        first_error.setdefault(service, t)
        start = t if start is None else min(start, t)
    elif level == "INFO" and text.startswith("recovered") and state.get(service):
        state[service] = False
        last_recovery[service] = t
assert not any(state.values())
candidates = [s for s in first_error if all(d not in first_error for d in deps[s])]
root = min(candidates, key=lambda s: first_error[s])
end = max(last_recovery.values())
print(root, alert - start, end - start)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/silent-root': ['earliest-error-root', 'mttd-from-root'],
	'middle/noisy-warn': ['warn-as-error', 'mttr-from-alert'],
	'middle/slow-recovery': ['mttr-root-only', 'first-alert-root'],
	'middle/flapping': ['first-recovery', 'mttr-from-alert'],
	'senior/clock-skew': ['skew-ignored', 'earliest-error-root'],
	'senior/two-candidates': ['first-alert-root', 'mttr-root-only'],
	'senior/skew-flap': ['skew-ignored', 'first-recovery'],
	'senior/deep-chain': ['named-upstream-root', 'earliest-error-root']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = analyse(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = analyse(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		if (input.classId === 'two-candidates' && Object.keys(p.deps).length && !twoCandidates(p)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ deps: p.deps, skew: p.skew, journal: journal(p) })
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

/** Two failed services both meet the root's definition. */
function twoCandidates(p: Params): boolean {
	const failed = new Set(p.entries.filter((e) => e.level === 'ERROR').map((e) => e.service));
	return [...failed].filter((s) => (p.deps[s] ?? []).every((d) => !failed.has(d))).length === 2;
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
