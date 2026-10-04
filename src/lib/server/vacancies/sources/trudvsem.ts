// «Работа России» open data API (`opendata.trudvsem.ru/api/v1/vacancies`): an official government source whose terms
// ask only for a link to trudvsem.ru. The portal is not IT-specific and does not archive old postings, so the imported
// scope is IT postings (by `category.specialisation`) created within the last `maxAgeDays`; the portal's `industry`
// filter does not work, so the listing searches by keywords and filters on the client (research of vacancy sources,
// 2026-09-24). A posting that leaves this scope is absent from a complete listing and is taken off.
import { canonicalJson } from '$lib/server/json/canonical';
import { removeContacts } from './contacts';
import { TRUDVSEM_SOURCE_KEY } from './definitions';
import { sha256Hex, sourceGet, type SourceHttpOptions } from './http';
import {
	sourceFail,
	sourceOk,
	type SourcePage,
	type SourcePosting,
	type SourceResult,
	type VacancySource
} from './types';

const ADAPTER_VERSION = 'trudvsem-opendata/1';
const API = 'https://opendata.trudvsem.ru/api/v1/vacancies';
export const IT_SPECIALISATION = 'Информационные технологии, телекоммуникации, связь';
/** The API answers at most 100 records per page and at most 10 000 records per query. */
const PAGE_SIZE = 100;
const RESULT_WINDOW = 10_000;

export const DEFAULT_TRUDVSEM_QUERIES = [
	'программист',
	'разработчик',
	'тестировщик',
	'аналитик данных',
	'системный аналитик',
	'devops',
	'системный администратор',
	'инженер данных'
] as const;

export interface TrudvsemSourceOptions {
	http: SourceHttpOptions;
	now: () => Date;
	queries?: readonly string[];
	/** Postings created earlier than this many days ago are outside the imported scope. */
	maxAgeDays?: number;
}

interface TrudvsemVacancy {
	id?: unknown;
	'job-name'?: unknown;
	vac_url?: unknown;
	company?: { name?: unknown; inn?: unknown; companycode?: unknown };
	'creation-date'?: unknown;
	date_modify?: unknown;
	salary?: unknown;
	salary_min?: unknown;
	salary_max?: unknown;
	currency?: unknown;
	qualification?: unknown;
	employment?: unknown;
	schedule?: unknown;
	region?: { name?: unknown };
	addresses?: { address?: { location?: unknown }[] };
	skills?: unknown;
	duty?: unknown;
	requirements?: unknown;
	category?: { specialisation?: unknown };
}

const str = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\s+/gu, ' ') : null;
const positive = (value: unknown): number | null => {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** `2026-09-14T17:07:29+0300` → ISO; the API writes offsets without a colon. */
function isoTime(value: unknown): string | null {
	const raw = str(value);
	if (raw === null) return null;
	const time = Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2'));
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function isoDay(value: unknown): string | null {
	const raw = str(value);
	return raw !== null && /^\d{4}-\d{2}-\d{2}$/u.test(raw) ? raw : null;
}

/**
 * `salary_min`/`salary_max` with the text «от N»: the API repeats the lower bound as the upper one when only «от» is
 * known, and writes 0 for an unknown bound. The text decides: «от N» with equal bounds is an open range.
 */
export function trudvsemSalary(v: TrudvsemVacancy): SourcePosting['salary'] {
	const rawText = str(v.salary);
	let min = positive(v.salary_min);
	let max = positive(v.salary_max);
	if (min !== null && max !== null && max < min) max = null;
	if (min !== null && max === min && rawText !== null && /^от\s/iu.test(rawText)) max = null;
	if (min === null && max === null) {
		return { min: null, max: null, currency: null, period: null, taxBase: null, rawText };
	}
	const currency = str(v.currency);
	if (min === null && max !== null && rawText !== null && /^от\s/iu.test(rawText)) {
		min = max;
		max = null;
	}
	return {
		min,
		max,
		currency: currency !== null && /руб/iu.test(currency) ? 'RUB' : null,
		// The portal publishes monthly wages; the tax base is not stated.
		period: 'month',
		taxBase: null,
		rawText
	};
}

function cityOf(v: TrudvsemVacancy): string | null {
	const location = str(v.addresses?.address?.[0]?.location);
	if (location === null) return null;
	const match = /(?:^|,\s*)г\.?\s+([^,]+)/u.exec(location);
	return match?.[1]?.trim() ?? null;
}

function uniqueStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(str).filter((s): s is string => s !== null))];
}

/** Scope of the import: an IT posting created within the age limit. */
export function inTrudvsemScope(v: TrudvsemVacancy, now: Date, maxAgeDays: number): boolean {
	if (str(v.category?.specialisation) !== IT_SPECIALISATION) return false;
	const created = isoDay(v['creation-date']);
	if (created === null) return false;
	const oldest = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
	return created >= oldest;
}

/** The page of a record as a web address; any other scheme (`javascript:`, `data:`) is no link to show. */
function webUrl(value: unknown): string | null {
	const raw = str(value);
	if (raw === null || !URL.canParse(raw)) return null;
	const url = new URL(raw);
	return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/** One API record as a posting; `null` — the record lacks its identity or a web address of its page. */
export function trudvsemPosting(v: TrudvsemVacancy): SourcePosting | null {
	const id = str(v.id);
	const companyCode = str(v.company?.companycode);
	const title = str(v['job-name']);
	const organization = str(v.company?.name);
	const url = webUrl(v.vac_url);
	if (id === null || companyCode === null || title === null || organization === null || url === null) return null;
	const inn = str(v.company?.inn);
	const employment = [str(v.employment), str(v.schedule)].filter((s): s is string => s !== null);
	const description = [str(v.duty), str(v.requirements)].filter((s): s is string => s !== null).join('\n\n');
	const cleaned = removeContacts(description);
	const qualification = str(v.qualification);
	return {
		externalId: `${companyCode}/${id}`,
		url,
		title,
		organization: {
			name: organization,
			inn: inn !== null && /^\d{10}(\d{2})?$/u.test(inn) ? inn : null,
			sourceOrgId: companyCode
		},
		publishedAt: isoDay(v['creation-date']) === null ? null : `${isoDay(v['creation-date'])}T00:00:00.000Z`,
		updatedAt: isoTime(v.date_modify),
		salary: trudvsemSalary(v),
		grade: qualification === null ? null : { raw: qualification.slice(0, 200) },
		location: {
			city: cityOf(v),
			remote: /дистанционн|удал[её]нн/iu.test(str(v.employment) ?? '') ? true : null,
			raw: str(v.region?.name)
		},
		employment: employment.length > 0 ? { raw: employment.join('; ') } : null,
		skillsRaw: uniqueStrings(v.skills),
		description: cleaned.text === '' ? null : cleaned.text,
		contactsRemoved: cleaned.removed,
		rawSha256: sha256Hex(canonicalJson(v))
	};
}

interface ApiPage {
	total: number;
	vacancies: TrudvsemVacancy[];
}

function readPage(body: string): ApiPage | null {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return null;
	}
	if (json === null || typeof json !== 'object') return null;
	const page = json as { status?: unknown; meta?: { total?: unknown }; results?: { vacancies?: unknown } };
	if (String(page.status) !== '200') return null;
	const total = Number(page.meta?.total);
	if (!Number.isInteger(total) || total < 0) return null;
	const list = page.results?.vacancies ?? [];
	if (!Array.isArray(list)) return null;
	const vacancies: TrudvsemVacancy[] = [];
	for (const entry of list) {
		const vacancy = (entry as { vacancy?: unknown } | null)?.vacancy;
		if (vacancy === null || typeof vacancy !== 'object') return null;
		vacancies.push(vacancy);
	}
	return { total, vacancies };
}

/** Cursor `query:page` over the list of keyword queries. */
function parseCursor(cursor: string | undefined, queries: number): { query: number; page: number } | null {
	if (cursor === undefined) return { query: 0, page: 0 };
	const match = /^(\d+):(\d+)$/u.exec(cursor);
	if (!match) return null;
	const query = Number(match[1]);
	const page = Number(match[2]);
	return query < queries ? { query, page } : null;
}

export class TrudvsemSource implements VacancySource {
	readonly source = TRUDVSEM_SOURCE_KEY;
	readonly adapterVersion = ADAPTER_VERSION;
	readonly listing = 'snapshot' as const;
	readonly itScope = 'source' as const;
	readonly #options: TrudvsemSourceOptions;
	readonly #queries: readonly string[];
	readonly #maxAgeDays: number;

	constructor(options: TrudvsemSourceOptions) {
		this.#options = options;
		this.#queries = options.queries ?? DEFAULT_TRUDVSEM_QUERIES;
		this.#maxAgeDays = options.maxAgeDays ?? 30;
		if (this.#queries.length === 0) throw new Error('trudvsem source needs at least one query');
	}

	async list(input: {
		mode: 'full' | 'incremental';
		since?: string;
		cursor?: string;
	}): Promise<SourceResult<SourcePage>> {
		const position = parseCursor(input.cursor, this.#queries.length);
		if (!position) return sourceFail('protocol_error', 'unknown cursor');
		const now = this.#options.now();
		// A posting in scope was created within the age limit, so it was also modified within it.
		const scopeStart = new Date(now.getTime() - this.#maxAgeDays * 86_400_000);
		const since = input.mode === 'incremental' && input.since !== undefined ? new Date(input.since) : scopeStart;
		if (Number.isNaN(since.getTime())) return sourceFail('protocol_error', 'invalid incremental start');
		const modifiedFrom = (since > scopeStart ? since : scopeStart).toISOString().replace(/\.\d{3}Z$/u, 'Z');
		const query = this.#queries[position.query] ?? '';
		const url = `${API}?${new URLSearchParams({
			text: query,
			modifiedFrom,
			limit: String(PAGE_SIZE),
			offset: String(position.page)
		}).toString()}`;
		const response = await sourceGet(url, 'application/json', this.#options.http);
		if (!response.ok) return response;
		if (response.value.status !== 200) {
			return sourceFail('protocol_error', 'vacancy listing is missing', { status: response.value.status });
		}
		const page = readPage(response.value.body);
		if (!page) return sourceFail('protocol_error', 'vacancy listing is not in the documented format');
		if (page.total > RESULT_WINDOW) {
			return sourceFail('protocol_error', 'query exceeds the result window of the API', {
				query: position.query,
				total: page.total
			});
		}
		const items = page.vacancies
			.filter((v) => inTrudvsemScope(v, now, this.#maxAgeDays))
			.map(trudvsemPosting)
			.filter((p): p is SourcePosting => p !== null);
		const morePages = (position.page + 1) * PAGE_SIZE < page.total;
		const nextCursor = morePages
			? `${position.query}:${position.page + 1}`
			: position.query + 1 < this.#queries.length
				? `${position.query + 1}:0`
				: null;
		return sourceOk({ items, nextCursor, sourceVersion: null, declaredTotal: null });
	}

	async get(externalId: string): Promise<SourceResult<SourcePosting | { gone: true }>> {
		const match = /^([0-9]+)\/([0-9a-f-]+)$/u.exec(externalId);
		if (!match) return sourceFail('protocol_error', 'not a trudvsem posting id');
		const response = await sourceGet(
			`${API}/vacancy/${match[1] ?? ''}/${match[2] ?? ''}`,
			'application/json',
			this.#options.http
		);
		if (!response.ok) return response;
		if (response.value.status === 404 || response.value.status === 410) return sourceOk({ gone: true });
		const page = readPage(response.value.body);
		if (!page) return sourceFail('protocol_error', 'vacancy record is not in the documented format');
		const [record] = page.vacancies;
		if (page.total === 0 || record === undefined) return sourceOk({ gone: true });
		if (!inTrudvsemScope(record, this.#options.now(), this.#maxAgeDays)) return sourceOk({ gone: true });
		const posting = trudvsemPosting(record);
		return posting ? sourceOk(posting) : sourceFail('protocol_error', 'vacancy record lacks its identity');
	}
}
