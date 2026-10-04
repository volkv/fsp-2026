// Lookup of a taxpayer number in a public registry: a hint for the operator and the applicant, never a proof of the
// applicant's authority (domain 5.2). Without a configured source the state says so explicitly, nothing is invented.
//
// The only source without a key is the public search of the Federal Tax Service (egrul.nalog.ru): an undocumented web
// form, not a published API. It answers without a captcha under light use and may demand one under load; terms of
// automated use are not published. The source is therefore opt-in, and every failure is `unavailable`.
import { isValidInn } from '$lib/server/auth/inn';

export type RegistrySource = 'egrul';

export interface RegistryRecord {
	inn: string;
	kind: 'organization' | 'entrepreneur';
	/** Full name; for an entrepreneur — the name of the person, as the registry publishes it. */
	name: string;
	shortName: string | null;
	ogrn: string | null;
	kpp: string | null;
	/** `YYYY-MM-DD`. */
	registeredOn: string | null;
	/** `YYYY-MM-DD` of liquidation or termination; `null` — the entity is active. */
	endedOn: string | null;
	/** Head of an organization as the registry states it: position and name. */
	head: string | null;
	region: string | null;
}

export type RegistryLookup =
	| { status: 'found'; source: RegistrySource; record: RegistryRecord }
	| { status: 'not_found'; source: RegistrySource }
	| {
			status: 'unavailable';
			source: RegistrySource;
			reason: 'network' | 'http_status' | 'captcha' | 'malformed' | 'timeout';
	  }
	| { status: 'not_configured' };

export interface CompanyRegistry {
	source: RegistrySource | null;
	lookup(inn: string, signal?: AbortSignal): Promise<RegistryLookup>;
}

/** No source is configured: every lookup says so. */
export const registryNotConfigured: CompanyRegistry = {
	source: null,
	lookup: () => Promise.resolve({ status: 'not_configured' })
};

/** The registry of the configured source (`COMPANY_REGISTRY`); without one — `registryNotConfigured`. */
export function configuredRegistry(source: RegistrySource | null): CompanyRegistry {
	return source === 'egrul' ? egrulRegistry() : registryNotConfigured;
}

export interface EgrulOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
	userAgent?: string;
	/** The search answers asynchronously: the result is polled after this delay. */
	pollDelayMs?: number;
	maxPolls?: number;
	timeoutMs?: number;
}

const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** `dd.mm.yyyy` → `yyyy-mm-dd`; anything else → `null`. */
function isoDate(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
	return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

class Unavailable extends Error {
	readonly reason: Extract<RegistryLookup, { status: 'unavailable' }>['reason'];
	constructor(reason: Extract<RegistryLookup, { status: 'unavailable' }>['reason'], cause?: unknown) {
		super(`registry unavailable: ${reason}`, { cause });
		this.reason = reason;
	}
}

function recordOf(row: Record<string, unknown>, inn: string): RegistryRecord | null {
	const name = text(row.n);
	if (text(row.i) !== inn || name === null) return null;
	return {
		inn,
		kind: row.k === 'fl' ? 'entrepreneur' : 'organization',
		name,
		shortName: text(row.c),
		ogrn: text(row.o),
		kpp: text(row.p),
		registeredOn: isoDate(row.r),
		endedOn: isoDate(row.e),
		head: text(row.g),
		region: text(row.rn)
	};
}

export function egrulRegistry(options: EgrulOptions = {}): CompanyRegistry {
	const fetchImpl = options.fetch ?? fetch;
	const baseUrl = options.baseUrl ?? 'https://egrul.nalog.ru';
	const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
	const pollDelayMs = options.pollDelayMs ?? 700;
	const maxPolls = options.maxPolls ?? 4;
	const timeoutMs = options.timeoutMs ?? 10_000;

	async function json(
		url: string,
		init: { method: 'GET' | 'POST'; body?: string; headers?: Record<string, string> },
		signal: AbortSignal
	): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: init.method,
				body: init.body,
				signal,
				headers: { 'user-agent': userAgent, accept: 'application/json', ...init.headers }
			});
		} catch (error) {
			if (signal.aborted) throw new Unavailable('timeout');
			throw new Unavailable('network', error);
		}
		if (!response.ok) throw new Unavailable('http_status');
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			throw new Unavailable('malformed', error);
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Unavailable('malformed');
		return body as Record<string, unknown>;
	}

	const wait = (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal.addEventListener(
				'abort',
				() => {
					clearTimeout(timer);
					reject(new Unavailable('timeout'));
				},
				{ once: true }
			);
		});

	async function search(inn: string, signal: AbortSignal): Promise<RegistryLookup> {
		const form = new URLSearchParams({
			vyp3CaptchaToken: '',
			page: '',
			query: inn,
			region: '',
			PreventChromeAutocomplete: ''
		});
		const started = await json(
			`${baseUrl}/`,
			{
				method: 'POST',
				body: form.toString(),
				headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
			},
			signal
		);
		if (started.captchaRequired === true) throw new Unavailable('captcha');
		const token = text(started.t);
		if (token === null || !/^[A-Za-z0-9]+$/.test(token)) throw new Unavailable('malformed');

		for (let poll = 0; poll < maxPolls; poll++) {
			await wait(pollDelayMs, signal);
			const result = await json(`${baseUrl}/search-result/${token}`, { method: 'GET' }, signal);
			if (result.status === 'wait') continue;
			const rows = result.rows;
			if (!Array.isArray(rows)) throw new Unavailable('malformed');
			for (const row of rows) {
				if (typeof row !== 'object' || row === null) continue;
				const record = recordOf(row as Record<string, unknown>, inn);
				if (record) return { status: 'found', source: 'egrul', record };
			}
			return { status: 'not_found', source: 'egrul' };
		}
		throw new Unavailable('timeout');
	}

	return {
		source: 'egrul',
		async lookup(inn, outer) {
			if (!isValidInn(inn)) return { status: 'not_found', source: 'egrul' };
			const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
			try {
				return await search(inn, signal);
			} catch (error) {
				if (error instanceof Unavailable) return { status: 'unavailable', source: 'egrul', reason: error.reason };
				throw error;
			}
		}
	};
}

const LEGAL_FORMS = [
	'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ',
	'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО',
	'НЕПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО',
	'АКЦИОНЕРНОЕ ОБЩЕСТВО',
	'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ',
	'ООО',
	'ПАО',
	'НАО',
	'АО',
	'ИП'
];

/** Name without quotes, punctuation, case and the legal form: «ООО "Ромашка"» and «Ромашка» compare equal. */
export function normalizeCompanyName(value: string): string {
	let name = value
		.normalize('NFKC')
		.toUpperCase()
		.replaceAll('Ё', 'Е')
		.replace(/[«»"'„“”.,()]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	for (const form of LEGAL_FORMS) {
		if (name.startsWith(`${form} `)) name = name.slice(form.length + 1);
		if (name.endsWith(` ${form}`)) name = name.slice(0, -(form.length + 1));
	}
	return name.trim();
}

/** Whether a declared name matches the full or the short name of the registry record. */
export function nameMatches(declared: string, record: RegistryRecord): boolean {
	const own = normalizeCompanyName(declared);
	if (own === '') return false;
	return [record.name, record.shortName].some((name) => name !== null && normalizeCompanyName(name) === own);
}
