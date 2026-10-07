// Content Security Policy level 3: given the policy headers of a page and what the page loads and runs, which loads
// and executions do not happen. Fallback of directives, matching of source expressions, nonces and hashes against
// 'unsafe-inline', 'strict-dynamic', several policies at once, report-only, -elem/-attr directives and duplicates.
import { createHash } from 'node:crypto';
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Kind =
	| 'ext-script'
	| 'inline-script'
	| 'dyn-script'
	| 'handler'
	| 'eval'
	| 'ext-style'
	| 'inline-style'
	| 'style-attr'
	| 'img'
	| 'fetch'
	| 'frame'
	| 'worker';

/** One load or execution of the page; `parent` is the index of the external script that performs it. */
interface Item {
	kind: Kind;
	url: string | null;
	nonce: string | null;
	content: string | null;
	parent: number | null;
}

interface Header {
	name: 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only';
	value: string;
}

interface Scenario {
	origin: string;
	headers: Header[];
	items: Item[];
}

interface Rules {
	defaultFallback: boolean;
	inlineIgnoredWithNonce: boolean;
	strictDynamic: boolean;
	childNeedsParent: boolean;
	wildcardApex: boolean;
	starMatchesData: boolean;
	selfSubdomains: boolean;
	pathMatters: boolean;
	frameViaChild: boolean;
	allPoliciesMustAllow: boolean;
	reportOnlyBlocks: boolean;
	elemAttr: boolean;
	duplicateLastWins: boolean;
	workerViaScript: boolean;
}

const RIGHT: Rules = {
	defaultFallback: true,
	inlineIgnoredWithNonce: true,
	strictDynamic: true,
	childNeedsParent: true,
	wildcardApex: false,
	starMatchesData: false,
	selfSubdomains: false,
	pathMatters: true,
	frameViaChild: true,
	allPoliciesMustAllow: true,
	reportOnlyBlocks: false,
	elemAttr: true,
	duplicateLastWins: false,
	workerViaScript: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'no-default-fallback': { defaultFallback: false },
	'unsafe-inline-with-nonce': { inlineIgnoredWithNonce: false },
	'strict-dynamic-ignored': { strictDynamic: false },
	'child-independent': { childNeedsParent: false },
	'wildcard-apex': { wildcardApex: true },
	'star-matches-data': { starMatchesData: true },
	'self-subdomains': { selfSubdomains: true },
	'path-ignored': { pathMatters: false },
	'frame-skip-child-src': { frameViaChild: false },
	'any-policy-allows': { allPoliciesMustAllow: false },
	'report-only-blocks': { reportOnlyBlocks: true },
	'elem-attr-ignored': { elemAttr: false },
	'duplicate-last-wins': { duplicateLastWins: true },
	'worker-skip-script-src': { workerViaScript: false }
};

// ---------------------------------------------------------------------------------------------------------------
// The model.

type Policy = Map<string, string[]>;

function parsePolicies(headers: readonly Header[], rules: Rules): { enforced: boolean; policy: Policy }[] {
	const out: { enforced: boolean; policy: Policy }[] = [];
	for (const header of headers) {
		for (const text of header.value.split(',')) {
			const policy: Policy = new Map();
			for (const raw of text.split(';')) {
				const tokens = raw.trim().split(/\s+/).filter(Boolean);
				const [name, ...sources] = tokens;
				if (name === undefined) continue;
				const key = name.toLowerCase();
				if (policy.has(key) && !rules.duplicateLastWins) continue;
				policy.set(key, sources);
			}
			out.push({ enforced: header.name === 'Content-Security-Policy', policy });
		}
	}
	return out;
}

/** The directives an item is checked against, most specific first. */
function chainOf(kind: Kind, rules: Rules): string[] {
	const elem = rules.elemAttr ? ['script-src-elem'] : [];
	switch (kind) {
		case 'ext-script':
		case 'inline-script':
		case 'dyn-script':
			return [...elem, 'script-src', 'default-src'];
		case 'handler':
			return [...(rules.elemAttr ? ['script-src-attr'] : []), 'script-src', 'default-src'];
		case 'eval':
			return ['script-src', 'default-src'];
		case 'ext-style':
		case 'inline-style':
			return [...(rules.elemAttr ? ['style-src-elem'] : []), 'style-src', 'default-src'];
		case 'style-attr':
			return [...(rules.elemAttr ? ['style-src-attr'] : []), 'style-src', 'default-src'];
		case 'img':
			return ['img-src', 'default-src'];
		case 'fetch':
			return ['connect-src', 'default-src'];
		case 'frame':
			return ['frame-src', ...(rules.frameViaChild ? ['child-src'] : []), 'default-src'];
		case 'worker':
			return ['worker-src', 'child-src', ...(rules.workerViaScript ? ['script-src'] : []), 'default-src'];
	}
}

const siteOf = (host: string): string => host.split('.').slice(-2).join('.');

function urlMatches(list: readonly string[], url: string, origin: string, rules: Rules): boolean {
	const u = new URL(url);
	const page = new URL(origin);
	const scheme = u.protocol.slice(0, -1);
	for (const source of list) {
		const s = source.toLowerCase();
		if (s === "'self'") {
			if (u.origin === page.origin) return true;
			if (rules.selfSubdomains && scheme === 'https' && siteOf(u.hostname) === siteOf(page.hostname)) return true;
			continue;
		}
		if (s === '*') {
			if (['http', 'https', 'ws', 'wss'].includes(scheme) || (rules.starMatchesData && scheme === 'data')) return true;
			continue;
		}
		if (s.startsWith("'")) continue;
		if (/^[a-z][a-z0-9+.-]*:$/.test(s)) {
			if (s === `${scheme}:`) return true;
			continue;
		}
		const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+)(\/.*)?$/.exec(s);
		if (!m) continue;
		const [, sScheme, wildcard, host, path] = m;
		if (scheme !== (sScheme ?? 'https')) continue;
		if (host === undefined) continue;
		const hostOk = wildcard
			? u.hostname.endsWith(`.${host}`) || (rules.wildcardApex && u.hostname === host)
			: u.hostname === host;
		if (!hostOk) continue;
		if (rules.pathMatters && path !== undefined && path !== '/') {
			if (path.endsWith('/') ? !u.pathname.startsWith(path) : u.pathname !== path) continue;
		}
		return true;
	}
	return false;
}

const hashOf = (content: string): string => `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`;

function allowsAllInline(list: readonly string[], script: boolean, rules: Rules): boolean {
	const lower = list.map((s) => s.toLowerCase());
	if (!lower.includes("'unsafe-inline'")) return false;
	if (!rules.inlineIgnoredWithNonce) return true;
	if (lower.some((s) => s.startsWith("'nonce-") || s.startsWith("'sha256-"))) return false;
	return !(script && rules.strictDynamic && lower.includes("'strict-dynamic'"));
}

function itemAllowed(item: Item, list: readonly string[], origin: string, rules: Rules): boolean {
	const nonceOk = item.nonce !== null && list.includes(`'nonce-${item.nonce}'`);
	const strict = rules.strictDynamic && list.map((s) => s.toLowerCase()).includes("'strict-dynamic'");
	switch (item.kind) {
		case 'ext-script':
		case 'dyn-script':
			if (nonceOk) return true;
			if (strict) return item.kind === 'dyn-script';
			return urlMatches(list, item.url ?? '', origin, rules);
		case 'inline-script':
			if (nonceOk || list.includes(`'${hashOf(item.content ?? '')}'`)) return true;
			return allowsAllInline(list, true, rules);
		case 'handler':
			return allowsAllInline(list, true, rules);
		case 'eval':
			return list.map((s) => s.toLowerCase()).includes("'unsafe-eval'");
		case 'ext-style':
			return nonceOk || urlMatches(list, item.url ?? '', origin, rules);
		case 'inline-style':
			if (nonceOk || list.includes(`'${hashOf(item.content ?? '')}'`)) return true;
			return allowsAllInline(list, false, rules);
		case 'style-attr':
			return allowsAllInline(list, false, rules);
		case 'img':
		case 'fetch':
		case 'frame':
		case 'worker':
			return urlMatches(list, item.url ?? '', origin, rules);
	}
}

/** Numbers (1-based) of the items that do not happen, ascending. */
function blocked(s: Scenario, rules: Rules): number[] {
	const policies = parsePolicies(s.headers, rules).filter((p) => p.enforced || rules.reportOnlyBlocks);
	const happens: boolean[] = [];
	s.items.forEach((item, i) => {
		const verdicts = policies.map(({ policy }) => {
			const directive = chainOf(item.kind, rules).find(
				(name) => policy.has(name) && (rules.defaultFallback || name !== 'default-src')
			);
			return directive === undefined ? true : itemAllowed(item, policy.get(directive) ?? [], s.origin, rules);
		});
		const allowed = rules.allPoliciesMustAllow
			? verdicts.every(Boolean)
			: verdicts.length === 0 || verdicts.some(Boolean);
		const parentOk = item.parent === null || !rules.childNeedsParent || (happens[item.parent] ?? false);
		happens[i] = allowed && parentOk;
	});
	return happens.flatMap((h, i) => (h ? [] : [i + 1]));
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const SITES = ['lavka.ru', 'knigoved.ru', 'marshrut.io', 'pogoda.dev', 'bilety.net', 'kofeinya.ru', 'sklad.tech'];
/** Public script CDNs and the path prefix of a package on each. */
const SCRIPT_CDNS = [
	['cdn.jsdelivr.net', '/npm/'],
	['unpkg.com', '/'],
	['cdnjs.cloudflare.com', '/ajax/libs/']
] as const;
const WIDGETS = ['widget.partner.io', 'chat.helpdesk.io', 'pay.provider.ru'];
const INLINE_CODE = [
	'initMenu();',
	'window.dataLayer = [];',
	'renderCart(%);',
	"document.documentElement.classList.add('js');",
	'startTimer(%);',
	"track('view', %);"
];
const NONCE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

interface Ctx {
	rng: Rng;
	site: string;
	origin: string;
	nonce: string;
	staleNonce: string;
	/** A public CDN with the package prefix: `https://cdn.jsdelivr.net/npm/`. */
	cdn: string;
	widget: string;
	/** Whether nonces appear on elements at all: only where a policy uses them. */
	nonces: boolean;
}

function nonceOf(rng: Rng): string {
	return Array.from({ length: 10 }, () => NONCE_CHARS.charAt(rng.int(0, NONCE_CHARS.length - 1))).join('');
}

function contextOf(rng: Rng, nonces: boolean): Ctx {
	const site = rng.pick(SITES);
	const [cdnHost, cdnPrefix] = rng.pick(SCRIPT_CDNS);
	return {
		rng,
		site,
		origin: `https://${rng.pick(['app', 'www', 'my'])}.${site}`,
		nonce: nonceOf(rng),
		staleNonce: nonceOf(rng),
		cdn: `https://${cdnHost}${cdnPrefix}`,
		widget: rng.pick(WIDGETS),
		nonces
	};
}

const code = (rng: Rng): string => rng.pick(INLINE_CODE).replace('%', String(rng.int(2, 99)));

/** A page item or a child action of an external script (index into the page items). */
interface Draft {
	item: Omit<Item, 'parent'>;
	parent: Draft | null;
}

const draft = (
	kind: Kind,
	fields: Partial<Omit<Item, 'kind' | 'parent'>> = {},
	parent: Draft | null = null
): Draft => ({
	item: { kind, url: null, nonce: null, content: null, ...fields },
	parent
});

/** Random filler of any kind the class allows: plausible loads whose fate depends on the policy. */
function filler(c: Ctx, kinds: readonly Kind[], parents: readonly Draft[]): Draft {
	const { rng, site, origin } = c;
	const kind = rng.pick(
		kinds.filter((k) => parents.length > 0 || !['dyn-script', 'eval', 'fetch', 'worker'].includes(k))
	);
	const parent = ['dyn-script', 'eval', 'fetch', 'worker'].includes(kind) ? rng.pick(parents) : null;
	switch (kind) {
		case 'ext-script':
			return draft(kind, {
				url: rng.pick([`${origin}/js/app.js`, `https://cdn.${site}/js/vendor.js`, `${c.cdn}dayjs.min.js`]),
				nonce: c.nonces && rng.bool(0.4) ? c.nonce : null
			});
		case 'inline-script':
			return draft(kind, { content: code(rng), nonce: c.nonces ? rng.pick([null, c.nonce, c.staleNonce]) : null });
		case 'dyn-script':
			return draft(
				kind,
				{ url: rng.pick([`https://${c.widget}/loader.js`, `https://static.${site}/js/chunk.js`]) },
				parent
			);
		case 'eval':
			return draft(kind, {}, parent);
		case 'handler':
			return draft(kind);
		case 'ext-style':
			return draft(kind, {
				url: rng.pick([
					`${origin}/css/main.css`,
					'https://fonts.googleapis.com/css2',
					`https://static.${site}/css/theme.css`
				])
			});
		case 'inline-style':
			return draft(kind, {
				content: `.card{gap:${rng.int(2, 24)}px}`,
				nonce: c.nonces && rng.bool(0.4) ? c.nonce : null
			});
		case 'style-attr':
			return draft(kind);
		case 'img':
			return draft(kind, {
				url: rng.pick([
					`${origin}/img/logo.svg`,
					`https://img.${site}/p/${rng.int(100, 999)}.webp`,
					'data:image/png;base64,iVBORw0KGgo=',
					'https://mc.yandex.ru/watch/1'
				])
			});
		case 'fetch':
			return draft(
				kind,
				{ url: rng.pick([`${origin}/api/cart`, `https://api.${site}/v1/menu`, 'https://mc.yandex.ru/collect']) },
				parent
			);
		case 'frame':
			return draft(kind, { url: rng.pick(['https://www.youtube.com/embed/xa7Kq', `https://${site}/embed/map`]) });
		case 'worker':
			return draft(kind, { url: `${origin}/js/worker.js` }, parent);
	}
}

interface Plan {
	headers: Header[];
	witnesses: Draft[];
	kinds: Kind[];
	parents: Draft[];
}

function strictDynamicPlan(c: Ctx): Plan {
	const { rng, site } = c;
	const listed = rng.pick([['https:'], [`https://cdn.${site}`], ["'self'", `https://cdn.${site}`]]);
	const unsafeEval = rng.bool(0.3);
	const directives = [
		`script-src 'nonce-${c.nonce}' 'strict-dynamic' ${listed.join(' ')} 'unsafe-inline'${unsafeEval ? " 'unsafe-eval'" : ''}`,
		"object-src 'none'",
		"base-uri 'none'",
		rng.pick(["default-src 'self'", `default-src 'self' https://*.${site}`])
	];
	if (rng.bool()) directives.push("img-src 'self' data:");
	if (rng.bool())
		directives.push(rng.pick(["style-src 'self' 'unsafe-inline'", `style-src 'self' 'nonce-${c.nonce}'`]));
	if (rng.bool()) directives.push(`connect-src 'self' https://api.${site}`);
	const headers: Header[] = [{ name: 'Content-Security-Policy', value: directives.join('; ') }];
	if (rng.bool())
		headers.push({ name: 'Content-Security-Policy-Report-Only', value: "default-src 'self'; report-uri /csp" });
	const loader = draft('ext-script', { url: `${c.cdn}loader.min.js`, nonce: c.nonce });
	const listedHost = listed.includes('https:') ? `https://${c.widget}/sdk.js` : `https://cdn.${site}/js/legacy.js`;
	const legacy = draft('ext-script', { url: listedHost });
	return {
		headers,
		witnesses: [
			loader,
			draft('dyn-script', { url: `https://${c.widget}/embed.js` }, loader),
			legacy,
			draft('dyn-script', { url: `https://static.${site}/js/chunk.js` }, legacy),
			draft('inline-script', { content: code(rng) })
		],
		kinds: ['inline-script', 'handler', 'eval', 'img', 'ext-style', 'inline-style', 'fetch', 'frame', 'style-attr'],
		parents: [loader]
	};
}

function multiplePoliciesPlan(c: Ctx): Plan {
	const { rng, site } = c;
	const extraScriptHost = rng.bool(0.3) ? ` ${new URL(c.cdn).origin}` : '';
	const p1 = [
		`default-src 'self' https://*.${site}`,
		`script-src 'self' https://cdn.${site}${extraScriptHost} 'unsafe-inline'`
	];
	if (rng.bool()) p1.push(rng.pick(['img-src *', "img-src 'self' data:"]));
	const p2 = [
		`script-src 'self' https:${rng.bool(0.5) ? " 'unsafe-eval'" : ''}`,
		`connect-src 'self' https://api.${site}`
	];
	p2.push(rng.pick([`img-src 'self' https://img.${site}`, `img-src 'self' https://img.${site} data:`]));
	if (rng.bool(0.6)) p2.push('frame-src https://www.youtube.com');
	p2.push("style-src 'self' 'unsafe-inline'");
	const enforced: Header[] = rng.bool()
		? [{ name: 'Content-Security-Policy', value: `${p1.join('; ')}, ${p2.join('; ')}` }]
		: [
				{ name: 'Content-Security-Policy', value: p1.join('; ') },
				{ name: 'Content-Security-Policy', value: p2.join('; ') }
			];
	const reportOnly: Header = {
		name: 'Content-Security-Policy-Report-Only',
		value: rng.pick(["default-src 'none'; report-uri /csp", "default-src 'self'; report-uri /csp"])
	};
	const headers = rng.shuffle([...enforced, reportOnly]);
	const app = draft('ext-script', { url: `https://cdn.${site}/js/app.js` });
	return {
		headers,
		witnesses: [
			app,
			draft('ext-script', { url: `https://${c.widget}/widget.js` }),
			draft('inline-script', { content: code(rng) }),
			draft('inline-style', { content: `.card{gap:${rng.int(2, 24)}px}` }),
			draft('fetch', { url: `https://api.${site}/v1/menu` }, app)
		],
		kinds: ['handler', 'eval', 'img', 'ext-style', 'fetch', 'frame', 'dyn-script', 'ext-script'],
		parents: [app]
	};
}

function fallbackPlan(c: Ctx): Plan {
	const { rng, site } = c;
	const witnessCode = code(rng);
	const directives = [
		`default-src 'self' https://*.${site}`,
		`script-src 'self' https://cdn.${site}/js/ '${hashOf(witnessCode)}' 'unsafe-inline'`,
		rng.pick(['img-src *', `img-src * https://img.${site}`]),
		'child-src https://www.youtube.com'
	];
	if (rng.bool()) directives.push("style-src 'self' 'unsafe-inline'");
	const app = draft('ext-script', { url: `https://cdn.${site}/js/app.js` });
	return {
		headers: [{ name: 'Content-Security-Policy', value: rng.shuffle(directives).join('; ') }],
		witnesses: [
			app,
			draft('ext-script', { url: `https://cdn.${site}/lib/chart.js` }),
			draft('ext-script', { url: `https://static.${site}/js/promo.js` }),
			draft('inline-script', { content: witnessCode }),
			draft('inline-script', { content: code(rng) }),
			draft('img', { url: 'data:image/png;base64,iVBORw0KGgo=' }),
			draft('frame', { url: 'https://www.youtube.com/embed/xa7Kq' }),
			draft('fetch', { url: `https://${site}/api/geo` }, app),
			draft('fetch', { url: 'https://mc.yandex.ru/collect' }, app)
		],
		kinds: ['handler', 'img', 'ext-style', 'inline-style', 'style-attr', 'frame', 'eval'],
		parents: [app]
	};
}

function granularPlan(c: Ctx): Plan {
	const { rng, site } = c;
	const childSrc = rng.bool(0.4);
	const duplicateEval = rng.bool(0.6);
	const directives = [
		"default-src 'none'",
		`script-src 'self' https://cdn.${site}`,
		`script-src-elem 'self' https://cdn.${site} https://${c.widget}`,
		"script-src-attr 'unsafe-inline'",
		"style-src 'self'",
		"style-src-attr 'unsafe-inline'",
		"img-src 'self'",
		`connect-src 'self' https://api.${site}`
	];
	if (childSrc) directives.push('child-src https://www.youtube.com');
	const late = duplicateEval ? "script-src 'self' 'unsafe-eval' https:" : "img-src 'self' data:";
	const ordered = rng.shuffle(directives);
	// The duplicate comes after the first directive of the same name.
	const firstAt = ordered.findIndex((d) => d.startsWith(duplicateEval ? 'script-src ' : 'img-src '));
	ordered.splice(rng.int(firstAt + 1, ordered.length), 0, late);
	const app = draft('ext-script', { url: `https://cdn.${site}/js/app.js` });
	return {
		headers: [{ name: 'Content-Security-Policy', value: ordered.join('; ') }],
		witnesses: [
			app,
			draft('ext-script', { url: `https://${c.widget}/widget.js` }),
			draft('handler'),
			draft('style-attr'),
			draft('worker', { url: `${c.origin}/js/worker.js` }, app),
			duplicateEval ? draft('eval', {}, app) : draft('img', { url: 'data:image/png;base64,iVBORw0KGgo=' })
		],
		kinds: ['inline-script', 'inline-style', 'ext-style', 'img', 'fetch', 'frame', 'eval'],
		parents: [app]
	};
}

const PLANS: Record<string, (c: Ctx) => Plan> = {
	'strict-dynamic': strictDynamicPlan,
	'multiple-policies': multiplePoliciesPlan,
	'fallback-matching': fallbackPlan,
	'granular-directives': granularPlan
};

/** Page items in shuffled order first, then child actions grouped by their parent's number. */
function layout(c: Ctx, plan: Plan, total: number): Scenario {
	const drafts = [...plan.witnesses];
	for (let guard = 0; drafts.length < total && guard < 100; guard += 1) {
		const d = filler(c, plan.kinds, plan.parents);
		// No two identical page items: each number is its own question.
		if (drafts.some((x) => JSON.stringify(x.item) === JSON.stringify(d.item) && x.parent === d.parent)) continue;
		drafts.push(d);
	}
	const pageItems = c.rng.shuffle(drafts.filter((d) => d.parent === null));
	const children = drafts.filter((d) => d.parent !== null);
	children.sort((a, b) => pageItems.indexOf(a.parent as Draft) - pageItems.indexOf(b.parent as Draft));
	const ordered = [...pageItems, ...children];
	return {
		origin: c.origin,
		headers: plan.headers,
		items: ordered.map((d) => ({ ...d.item, parent: d.parent === null ? null : ordered.indexOf(d.parent) }))
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function markup(item: Item): string {
	const nonce = item.nonce === null ? '' : ` nonce="${item.nonce}"`;
	switch (item.kind) {
		case 'ext-script':
			return `<script src="${item.url ?? ''}"${nonce}></script>`;
		case 'inline-script':
			return `<script${nonce}>${item.content ?? ''}</script>`;
		case 'handler':
			return '<button onclick="addToCart(this.dataset.id)" data-id="12">В корзину</button>';
		case 'ext-style':
			return `<link rel="stylesheet" href="${item.url ?? ''}"${nonce}>`;
		case 'inline-style':
			return `<style${nonce}>${item.content ?? ''}</style>`;
		case 'style-attr':
			return '<div class="promo" style="display:none">…</div>';
		case 'img':
			return `<img src="${item.url ?? ''}" alt="">`;
		case 'frame':
			return `<iframe src="${item.url ?? ''}"></iframe>`;
		default:
			throw new Error(`${item.kind} is not a page item`);
	}
}

function action(item: Item, origin: string): string {
	switch (item.kind) {
		case 'dyn-script':
			return `вставляет скрипт: \`const s = document.createElement('script'); s.src = '${item.url ?? ''}'; document.head.append(s);\``;
		case 'eval':
			return 'вызывает `eval(config.expr)`';
		case 'fetch':
			return `запрашивает \`fetch('${item.url ?? ''}')\``;
		case 'worker': {
			const path = (item.url ?? '').slice(origin.length);
			return `запускает \`new Worker('${path}')\``;
		}
		default:
			throw new Error(`${item.kind} is not an action`);
	}
}

function describe(s: Scenario): string {
	const pageCount = s.items.filter((i) => i.parent === null).length;
	const html = s.items.slice(0, pageCount).map((item, i) => `<!-- ${i + 1} --> ${markup(item)}`);
	const actions = s.items.slice(pageCount).map((item, i) => {
		const parent = s.items[item.parent ?? 0];
		const file = parent?.url?.split('/').pop() ?? '';
		return `${pageCount + i + 1}. Скрипт ${(item.parent ?? 0) + 1} (\`${file}\`), если выполнится, ${action(item, s.origin)}.`;
	});
	const hashes = s.items.flatMap((item, i) =>
		item.kind === 'inline-script' ? [`- элемент ${i + 1}: \`${hashOf(item.content ?? '')}\``] : []
	);
	return [
		`Страница \`${s.origin}/catalog\` пришла с заголовками:`,
		'',
		'```http',
		...s.headers.map((h) => `${h.name}: ${h.value}`),
		'```',
		'',
		'Элементы страницы в порядке документа (номер — в комментарии):',
		'',
		'```html',
		...html,
		'```',
		'',
		...(actions.length ? ['Действия внешних скриптов:', '', ...actions, ''] : []),
		...(hashes.length ? ['SHA-256 содержимого инлайн-скриптов (в base64, как в CSP):', '', ...hashes, ''] : []),
		'Считаем, что браузер полностью поддерживает CSP уровня 3; все адреса существуют и без политики загрузились бы; пользователь нажимает каждую кнопку; других заголовков и тегов `<meta>` с политикой нет.',
		'',
		`Введите через пробел в порядке возрастания номера всех пунктов (1–${s.items.length}), которые **не** произойдут: загрузка или исполнение заблокированы политикой либо действие не начнётся, потому что не выполнился вызвавший его скрипт. Например: \`2 5 9\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import base64
import hashlib
import json
import re
from urllib.parse import urlsplit

s = json.loads(input())
page = urlsplit(s["origin"])

FALLBACK = {
    "ext-script": ["script-src-elem", "script-src", "default-src"],
    "inline-script": ["script-src-elem", "script-src", "default-src"],
    "dyn-script": ["script-src-elem", "script-src", "default-src"],
    "handler": ["script-src-attr", "script-src", "default-src"],
    "eval": ["script-src", "default-src"],
    "ext-style": ["style-src-elem", "style-src", "default-src"],
    "inline-style": ["style-src-elem", "style-src", "default-src"],
    "style-attr": ["style-src-attr", "style-src", "default-src"],
    "img": ["img-src", "default-src"],
    "fetch": ["connect-src", "default-src"],
    "frame": ["frame-src", "child-src", "default-src"],
    "worker": ["worker-src", "child-src", "script-src", "default-src"],
}


def policies():
    result = []
    for h in s["headers"]:
        if h["name"].lower() != "content-security-policy":
            continue
        for text in h["value"].split(","):
            directives = {}
            for part in text.split(";"):
                words = part.split()
                if words and words[0].lower() not in directives:
                    directives[words[0].lower()] = words[1:]
            result.append(directives)
    return result


def host_matches(expr, url):
    m = re.fullmatch(r"(?:([a-z][a-z0-9+.-]*)://)?([^/]+)(/.*)?", expr)
    if not m:
        return False
    scheme, host, path = m.group(1), m.group(2), m.group(3)
    if url.scheme != (scheme or "https"):
        return False
    if host.startswith("*."):
        if not url.hostname.endswith(host[1:]):
            return False
    elif url.hostname != host:
        return False
    if path and path != "/":
        if path.endswith("/"):
            return url.path.startswith(path)
        return url.path == path
    return True


def url_allowed(sources, raw):
    url = urlsplit(raw)
    for src in sources:
        low = src.lower()
        if low == "'self'":
            if (url.scheme, url.netloc) == (page.scheme, page.netloc):
                return True
        elif low == "*":
            if url.scheme in ("http", "https", "ws", "wss"):
                return True
        elif low.startswith("'"):
            continue
        elif re.fullmatch(r"[a-z][a-z0-9+.-]*:", low):
            if low[:-1] == url.scheme:
                return True
        elif host_matches(low, url):
            return True
    return False


def digest(text):
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"


def inline_ok(sources, scripty):
    low = [x.lower() for x in sources]
    if "'unsafe-inline'" not in low:
        return False
    if any(x.startswith("'nonce-") or x.startswith("'sha256-") for x in low):
        return False
    if scripty and "'strict-dynamic'" in low:
        return False
    return True


def allowed(item, sources):
    kind = item["kind"]
    nonce = item["nonce"] is not None and ("'nonce-" + item["nonce"] + "'") in sources
    strict = "'strict-dynamic'" in [x.lower() for x in sources]
    if kind in ("ext-script", "dyn-script"):
        if nonce:
            return True
        if strict:
            return kind == "dyn-script"
        return url_allowed(sources, item["url"])
    if kind in ("inline-script", "inline-style"):
        if nonce or digest(item["content"]) in sources:
            return True
        return inline_ok(sources, kind == "inline-script")
    if kind == "handler":
        return inline_ok(sources, True)
    if kind == "style-attr":
        return inline_ok(sources, False)
    if kind == "eval":
        return "'unsafe-eval'" in [x.lower() for x in sources]
    if kind == "ext-style" and nonce:
        return True
    return url_allowed(sources, item["url"])


enforced = policies()
done = []
for item in s["items"]:
    ok = item["parent"] is None or done[item["parent"]]
    for pol in enforced:
        if not ok:
            break
        for name in FALLBACK[item["kind"]]:
            if name in pol:
                ok = allowed(item, pol[name])
                break
    done.append(ok)
print(" ".join(str(i + 1) for i, d in enumerate(done) if not d))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/strict-dynamic': ['strict-dynamic-ignored', 'unsafe-inline-with-nonce', 'child-independent'],
	'senior/multiple-policies': ['any-policy-allows', 'report-only-blocks', 'no-default-fallback'],
	'senior/fallback-matching': [
		'no-default-fallback',
		'unsafe-inline-with-nonce',
		'wildcard-apex',
		'star-matches-data',
		'self-subdomains',
		'path-ignored',
		'frame-skip-child-src'
	],
	'senior/granular-directives': ['elem-attr-ignored', 'duplicate-last-wins']
};

interface Attempt {
	scenario: Scenario;
	answer: string;
	wrong: Record<string, string | null>;
}

function attempt(rng: Rng, classId: string, required: readonly string[]): Attempt | null {
	const plan = PLANS[classId];
	if (!plan) throw new Error(`${descriptor.key}: no plan for ${classId}`);
	const c = contextOf(rng, classId === 'strict-dynamic');
	const p = plan(c);
	const scenario = layout(c, p, Math.max(p.witnesses.length + 2, rng.int(10, 13)));
	const answer = blocked(scenario, RIGHT).join(' ');
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = blocked(scenario, { ...RIGHT, ...change }).join(' ');
			return [id, value === answer ? null : value];
		})
	);
	const count = answer.split(' ').filter(Boolean).length;
	if (count < 2 || count > scenario.items.length - 2) return null;
	if (required.some((id) => wrong[id] === null)) return null;
	return { scenario, answer, wrong };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let found: Attempt | null = null;
	for (let tries = 0; tries < 300 && found === null; tries += 1) found = attempt(rng, input.classId, required);
	// A fixed stream that is known to settle keeps the generator total.
	const fallback = new Rng(`${descriptor.key}|${input.grade}|${input.classId}|fallback`);
	for (let tries = 0; tries < 300 && found === null; tries += 1) found = attempt(fallback, input.classId, required);
	if (found === null) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	const { scenario, answer, wrong } = found;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(scenario), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(scenario) }),
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
