// Habr Career through its public RSS feed (`career.habr.com/vacancies/rss`): the latest postings, with the source named
// and linked on every card. The terms of the site do not allow copying its content, so only the white list of fields
// is kept and no description is stored (research of vacancy sources, 2026-09-24). The feed is a window of recent
// postings, not a snapshot: a posting leaves only through `get`, which reads the public page of the vacancy.
import { XMLParser } from 'fast-xml-parser';
import { canonicalJson } from '$lib/server/json/canonical';
import { HABR_SOURCE_KEY } from './definitions';
import { sha256Hex, sourceGet, type SourceHttpOptions } from './http';
import {
	sourceFail,
	sourceOk,
	type SourcePage,
	type SourcePosting,
	type SourceResult,
	type VacancySource
} from './types';

const ADAPTER_VERSION = 'habr-rss/1';
const ORIGIN = 'https://career.habr.com';

/** One `<item>` of the feed as text; absent elements are `null`. */
export interface FeedItem {
	title: string | null;
	description: string | null;
	author: string | null;
	pubDate: string | null;
	link: string | null;
	guid: string | null;
}

// Values stay text (a numeric `guid` keeps its digits as written), attributes are dropped, and entity expansion keeps
// the parser's limits against expansion attacks.
const feedParser = new XMLParser({ isArray: (name) => name === 'item', parseTagValue: false });

function feedText(item: Record<string, unknown>, field: keyof FeedItem): string | null {
	const value = item[field];
	if (value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`feed item field ${field} is not text`);
	return value;
}

/** Reads the items of an RSS 2.0 document; throws on a document that is not RSS. */
export function parseFeed(xml: string): FeedItem[] {
	const document: unknown = feedParser.parse(xml);
	const channel = (document as { rss?: { channel?: unknown } } | null)?.rss?.channel;
	if (typeof channel !== 'object' || channel === null) throw new Error('not an RSS document');
	const items = (channel as { item?: unknown }).item;
	if (items === undefined) return [];
	if (!Array.isArray(items)) throw new Error('feed items are not a list');
	return items.map((item: unknown) => {
		if (typeof item !== 'object' || item === null) throw new Error('feed item is not an element');
		const fields = item as Record<string, unknown>;
		return {
			title: feedText(fields, 'title'),
			description: feedText(fields, 'description'),
			author: feedText(fields, 'author'),
			pubDate: feedText(fields, 'pubDate'),
			link: feedText(fields, 'link'),
			guid: feedText(fields, 'guid')
		};
	});
}

export interface HabrSourceOptions {
	http: SourceHttpOptions;
	/** The clock of freshness decisions (`validThrough` of a page). */
	now: () => Date;
}

const GRADE_TAGS = new Set(['intern', 'junior', 'middle', 'senior', 'lead']);

const CURRENCY_SIGNS: Record<string, string> = { '₽': 'RUB', $: 'USD', '€': 'EUR' };

function amount(text: string): number {
	return Number(text.replace(/[\s\u00a0\u202f]/gu, ''));
}

/** «От 50 000 ₽ до 70 000 ₽», «От 70 000 ₽», «До 90 000 ₽» — the salary sentence of the feed template. */
export function parseHabrSalary(sentence: string): SourcePosting['salary'] | null {
	const match = /^(?:от\s+([\d\s\u00a0\u202f]+?)\s*(₽|\$|€))?\s*(?:до\s+([\d\s\u00a0\u202f]+?)\s*(₽|\$|€))?$/iu.exec(
		sentence.trim()
	);
	if (!match || (match[1] === undefined && match[3] === undefined)) return null;
	const [, from, fromSign, to, toSign] = match;
	const sign = fromSign ?? toSign;
	if (fromSign !== undefined && toSign !== undefined && fromSign !== toSign) return null;
	return {
		min: from === undefined ? null : amount(from),
		max: to === undefined ? null : amount(to),
		currency: sign === undefined ? null : (CURRENCY_SIGNS[sign] ?? null),
		// Habr Career publishes monthly salaries; the tax base is not stated.
		period: 'month',
		taxBase: null,
		rawText: sentence.trim()
	};
}

const NO_SALARY: SourcePosting['salary'] = {
	min: null,
	max: null,
	currency: null,
	period: null,
	taxBase: null,
	rawText: null
};

/**
 * «Требуется «Title» (City)» → the title of the vacancy exactly as the template quotes it (the description repeats it
 * verbatim, spaces included); another shape is kept as is.
 */
export function habrTitle(feedTitle: string): string {
	const prefix = 'Требуется «';
	if (!feedTitle.startsWith(prefix)) return feedTitle;
	const end = feedTitle.lastIndexOf('»');
	if (end <= prefix.length) return feedTitle;
	return feedTitle.slice(prefix.length, end);
}

interface TemplateFields {
	cities: string[];
	locationRaw: string | null;
	employment: string | null;
	remote: boolean | null;
	salary: SourcePosting['salary'];
	grades: string[];
	skills: string[];
}

/**
 * The feed description is a template: «Компания «X» ищет хорошего специалиста на вакансию «T». Город (Страна).
 * Полный рабочий день. Можно удалённо. От N ₽. Требуемые навыки: #grade, #Skill.» Each sentence is optional.
 */
export function parseHabrDescription(description: string, title: string): TemplateFields {
	const fields: TemplateFields = {
		cities: [],
		locationRaw: null,
		employment: null,
		remote: null,
		salary: NO_SALARY,
		grades: [],
		skills: []
	};
	const marker = `на вакансию «${title}».`;
	const at = description.indexOf(marker);
	const loose = /на вакансию «.*?»\.(?=\s|$)/u.exec(description);
	let rest = (
		at >= 0 ? description.slice(at + marker.length) : loose ? description.slice(loose.index + loose[0].length) : ''
	).trim();

	const skillsAt = rest.indexOf('Требуемые навыки:');
	if (skillsAt >= 0) {
		const list = rest
			.slice(skillsAt + 'Требуемые навыки:'.length)
			.trim()
			.replace(/\.$/u, '');
		for (const tag of list.split(/,\s*/u)) {
			const value = tag.trim().replace(/^#/u, '');
			if (value === '') continue;
			if (GRADE_TAGS.has(value.toLowerCase())) fields.grades.push(value.toLowerCase());
			else fields.skills.push(value);
		}
		rest = rest.slice(0, skillsAt).trim();
	}

	for (const raw of rest.split(/\.(?:\s+|$)/u)) {
		const sentence = raw.trim();
		if (sentence === '') continue;
		if (/^можно удал[её]нно$/iu.test(sentence)) {
			fields.remote = true;
		} else if (/рабочий день|занятость|график/iu.test(sentence)) {
			fields.employment = sentence;
		} else if (/^(от|до)\s/iu.test(sentence)) {
			fields.salary = parseHabrSalary(sentence) ?? NO_SALARY;
		} else if (/\([^()]+\)/u.test(sentence)) {
			fields.locationRaw = sentence;
			fields.cities = sentence
				.split(/,\s*/u)
				.map((place) => place.replace(/\s*\([^()]*\)\s*$/u, '').trim())
				.filter((place) => place !== '');
		}
	}
	return fields;
}

function isoDate(text: string | null): string | null {
	if (text === null) return null;
	const time = Date.parse(text);
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** One feed item as a posting; `null` — the item lacks its identity (guid or link). */
export function habrPostingFromFeed(item: FeedItem): SourcePosting | null {
	const externalId = item.guid?.trim() ?? '';
	const url = item.link?.trim() ?? '';
	if (!/^\d+$/u.test(externalId) || !url.startsWith(`${ORIGIN}/vacancies/`)) return null;
	const quoted = habrTitle(item.title ?? '');
	const title = quoted.trim();
	if (title === '') return null;
	const fields = parseHabrDescription(item.description ?? '', quoted);
	return {
		externalId,
		url,
		title,
		organization: { name: (item.author ?? '').trim(), inn: null, sourceOrgId: null },
		publishedAt: isoDate(item.pubDate),
		updatedAt: isoDate(item.pubDate),
		salary: fields.salary,
		grade: fields.grades.length > 0 ? { raw: fields.grades.join(', ') } : null,
		location: { city: fields.cities[0] ?? null, remote: fields.remote, raw: fields.locationRaw },
		employment: fields.employment === null ? null : { raw: fields.employment },
		skillsRaw: fields.skills,
		description: null,
		contactsRemoved: false,
		rawSha256: sha256Hex(canonicalJson({ ...item }))
	};
}

// --- The page of one vacancy: schema.org JobPosting ---

interface JobPosting {
	title?: unknown;
	datePosted?: unknown;
	validThrough?: unknown;
	description?: unknown;
	hiringOrganization?: { name?: unknown };
	jobLocation?: { address?: { addressLocality?: unknown } };
	jobLocationType?: unknown;
	employmentType?: unknown;
	baseSalary?: { currency?: unknown; value?: { minValue?: unknown; maxValue?: unknown; unitText?: unknown } };
}

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const count = (value: unknown): number | null =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

const UNIT_PERIODS: Record<string, SourcePosting['salary']['period']> = {
	MONTH: 'month',
	YEAR: 'year',
	HOUR: 'hour'
};

/** The JSON-LD JobPosting of a vacancy page; `null` — the page has none. */
export function jobPostingOf(html: string): JobPosting | null {
	for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(match[1] ?? '');
		} catch {
			// A block that is not JSON is not the posting; the next block may be.
			continue;
		}
		if (parsed !== null && typeof parsed === 'object' && (parsed as { '@type'?: unknown })['@type'] === 'JobPosting') {
			return parsed;
		}
	}
	return null;
}

/** «Навыки: A, B. Квалификация: Lead.» — the first paragraph of the page description. */
function pageSummary(description: string | null): { skills: string[]; grade: string | null } {
	if (description === null) return { skills: [], grade: null };
	const plain = description.replace(/<[^>]+>/gu, ' ');
	const skills = /Навыки:\s*(.+?)\.(?=\s|$)/u.exec(plain)?.[1];
	const grade = /Квалификация:\s*(.+?)\.(?=\s|$)/u.exec(plain)?.[1];
	return {
		skills:
			skills === undefined
				? []
				: skills
						.split(/,\s*/u)
						.map((s) => s.trim())
						.filter((s) => s !== ''),
		grade: grade === undefined ? null : grade.trim()
	};
}

export function habrPostingFromPage(
	externalId: string,
	html: string,
	now: Date
): SourceResult<SourcePosting | { gone: true }> {
	const posting = jobPostingOf(html);
	if (!posting) return sourceFail('protocol_error', 'vacancy page carries no JobPosting');
	const validThrough = text(posting.validThrough);
	if (validThrough !== null && validThrough < now.toISOString().slice(0, 10)) return sourceOk({ gone: true });
	const title = text(posting.title);
	const organization = text(posting.hiringOrganization?.name);
	if (title === null || organization === null)
		return sourceFail('protocol_error', 'JobPosting lacks title or organization');
	const summary = pageSummary(text(posting.description));
	const salaryValue = posting.baseSalary?.value;
	const min = count(salaryValue?.minValue);
	const max = count(salaryValue?.maxValue);
	const unit = text(salaryValue?.unitText);
	const currency = text(posting.baseSalary?.currency);
	const city = text(posting.jobLocation?.address?.addressLocality);
	const employment = text(posting.employmentType);
	return sourceOk({
		externalId,
		url: `${ORIGIN}/vacancies/${externalId}`,
		title,
		organization: { name: organization, inn: null, sourceOrgId: null },
		publishedAt: isoDate(text(posting.datePosted)),
		updatedAt: isoDate(text(posting.datePosted)),
		salary:
			min === null && max === null
				? NO_SALARY
				: {
						min,
						max,
						currency: currency !== null && /^[A-Z]{3}$/u.test(currency) ? currency : null,
						period: unit === null ? null : (UNIT_PERIODS[unit] ?? null),
						taxBase: null,
						rawText: null
					},
		grade: summary.grade === null ? null : { raw: summary.grade },
		location: {
			city,
			remote: posting.jobLocationType === 'TELECOMMUTE' ? true : null,
			raw: city
		},
		employment: employment === null ? null : { raw: employment },
		skillsRaw: summary.skills,
		description: null,
		contactsRemoved: false,
		rawSha256: sha256Hex(canonicalJson(posting))
	});
}

export class HabrCareerSource implements VacancySource {
	readonly source = HABR_SOURCE_KEY;
	readonly adapterVersion = ADAPTER_VERSION;
	readonly listing = 'recent_window' as const;
	readonly itScope = 'taxonomy' as const;
	readonly #options: HabrSourceOptions;

	constructor(options: HabrSourceOptions) {
		this.#options = options;
	}

	/** The feed has one page; `mode` and `since` do not change what it returns. */
	async list(): Promise<SourceResult<SourcePage>> {
		const response = await sourceGet(
			`${ORIGIN}/vacancies/rss`,
			'application/rss+xml, application/xml',
			this.#options.http
		);
		if (!response.ok) return response;
		if (response.value.status !== 200) {
			return sourceFail('protocol_error', 'the feed is missing', { status: response.value.status });
		}
		let items: FeedItem[];
		try {
			items = parseFeed(response.value.body);
		} catch (error) {
			return sourceFail('protocol_error', 'the feed is not RSS', {
				reason: error instanceof Error ? error.name : 'unknown'
			});
		}
		const postings = items.map(habrPostingFromFeed).filter((p): p is SourcePosting => p !== null);
		return sourceOk({ items: postings, nextCursor: null, sourceVersion: null, declaredTotal: null });
	}

	async get(externalId: string): Promise<SourceResult<SourcePosting | { gone: true }>> {
		if (!/^\d+$/u.test(externalId)) return sourceFail('protocol_error', 'not a Habr Career vacancy id');
		const response = await sourceGet(`${ORIGIN}/vacancies/${externalId}`, 'text/html', this.#options.http);
		if (!response.ok) return response;
		if (response.value.status === 404 || response.value.status === 410) return sourceOk({ gone: true });
		return habrPostingFromPage(externalId, response.value.body, this.#options.now());
	}
}
