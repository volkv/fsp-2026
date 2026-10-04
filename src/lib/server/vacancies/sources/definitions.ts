// Catalog of the vacancy sources the product has adapters for (docs/domain.md, section 13.2): the row of
// `vacancy_sources` each one needs, with its terms of use as checked by the research of 2026-09-24. getmatch, GeekJob
// and hh.ru forbid our use in their own terms and have no adapter.
// Imported by plain Node (scripts/seed-policies.ts): no SvelteKit aliases, erasable syntax only.
import type postgres from 'postgres';
import { z } from 'zod';

export const HABR_SOURCE_KEY = 'habr_career';
export const TRUDVSEM_SOURCE_KEY = 'trudvsem';

export const sourceTermsSchema = z.object({
	status: z.enum(['unchecked', 'allowed', 'restricted', 'forbidden']),
	checked_at: z.iso.date(),
	url: z.url(),
	/** The description of a posting may be stored. */
	store_description: z.boolean(),
	/** What every card of the source shows. */
	attribution: z.string().min(1)
});

export type SourceTerms = z.infer<typeof sourceTermsSchema>;

export const sourceScheduleSchema = z.object({
	/** Hours between full imports. */
	full_every_hours: z.int().positive(),
	/** Hours between incremental imports; `null` — the source has none. */
	incremental_every_hours: z.int().positive().nullable(),
	/** Hours after which an unconfirmed posting gets a freshness check. */
	check_after_hours: z.int().positive()
});

export type SourceSchedule = z.infer<typeof sourceScheduleSchema>;

export interface SourceDefinition {
	key: string;
	name: string;
	siteUrl: string;
	adapterVersion: string;
	terms: SourceTerms;
	schedule: SourceSchedule;
}

export const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
	{
		key: HABR_SOURCE_KEY,
		name: 'Хабр Карьера',
		siteUrl: 'https://career.habr.com',
		adapterVersion: 'habr-rss/1',
		terms: {
			// The public feed is open to readers, but the user agreement (5.3) forbids copying content: only the white
			// list of fields and a link, no descriptions. Not checked by a lawyer.
			status: 'restricted',
			checked_at: '2026-09-24',
			url: 'https://career.habr.com/info/agreement',
			store_description: false,
			attribution: 'По данным Хабр Карьеры'
		},
		schedule: { full_every_hours: 1, incremental_every_hours: null, check_after_hours: 24 }
	},
	{
		key: TRUDVSEM_SOURCE_KEY,
		name: 'Работа России',
		siteUrl: 'https://trudvsem.ru',
		adapterVersion: 'trudvsem-opendata/1',
		terms: {
			// Open government data: copying is allowed with a link to trudvsem.ru.
			status: 'allowed',
			checked_at: '2026-09-24',
			url: 'https://trudvsem.ru/opendata/api',
			store_description: true,
			attribution: 'По данным портала «Работа России» (trudvsem.ru)'
		},
		schedule: { full_every_hours: 24, incremental_every_hours: 3, check_after_hours: 72 }
	}
];

export interface RegisteredSource {
	key: string;
	outcome: 'added' | 'updated';
	enabled: boolean;
}

/**
 * Writes the catalog into `vacancy_sources`: new sources are added disabled (an administrator enables them), known ones
 * get the current name, adapter version, terms and schedule; `enabled` is kept, except that terms forbidding use switch
 * the source off (`vacancy_sources_forbidden_disabled`). Repeating it leaves the rows as they are.
 */
export async function registerVacancySources(client: postgres.Sql): Promise<RegisteredSource[]> {
	// JSON goes as text cast in the query: the serializer of a jsonb parameter differs between a plain client and one
	// shared with Drizzle, a text parameter is sent as is by both.
	const registered: RegisteredSource[] = [];
	for (const definition of SOURCE_DEFINITIONS) {
		const [row] = await client<{ enabled: boolean; added: boolean }[]>`
			insert into vacancy_sources (key, name, site_url, adapter_version, terms, schedule, enabled)
			values (${definition.key}, ${definition.name}, ${definition.siteUrl}, ${definition.adapterVersion},
				${JSON.stringify(definition.terms)}::text::jsonb, ${JSON.stringify(definition.schedule)}::text::jsonb, false)
			on conflict (key) do update set
				name = excluded.name,
				site_url = excluded.site_url,
				adapter_version = excluded.adapter_version,
				terms = excluded.terms,
				schedule = excluded.schedule,
				enabled = vacancy_sources.enabled and excluded.terms->>'status' <> 'forbidden',
				updated_at = now()
			returning enabled, (xmax = 0) as added`;
		if (!row) throw new Error(`vacancy source ${definition.key} was not written`);
		registered.push({ key: definition.key, outcome: row.added ? 'added' : 'updated', enabled: row.enabled });
	}
	return registered;
}
