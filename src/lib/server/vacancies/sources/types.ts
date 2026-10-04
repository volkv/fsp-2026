// Vacancy source adapter contract (docs/contracts.md, section 7). An adapter reads one external source and returns
// postings in one shape; normalization to the taxonomy, clustering of duplicates and storage are done by the
// application (docs/domain.md, section 13.2), never by the adapter. Exceptions do not cross the adapter boundary.

export type SourceErrorCode = 'unavailable' | 'rate_limited' | 'forbidden' | 'protocol_error';

export interface SourceError {
	code: SourceErrorCode;
	retryable: boolean;
	/** Without personal data. */
	message: string;
	details?: Record<string, unknown>;
}

export type SourceResult<T> = { ok: true; value: T } | { ok: false; error: SourceError };

const RETRYABLE: Record<SourceErrorCode, boolean> = {
	unavailable: true,
	rate_limited: true,
	forbidden: false,
	protocol_error: false
};

export const sourceOk = <T>(value: T): SourceResult<T> => ({ ok: true, value });

export function sourceFail(
	code: SourceErrorCode,
	message: string,
	details?: Record<string, unknown>
): { ok: false; error: SourceError } {
	return { ok: false, error: { code, retryable: RETRYABLE[code], message, ...(details ? { details } : {}) } };
}

export type SalaryPeriod = 'month' | 'year' | 'hour' | 'project';

/**
 * One posting as the source publishes it, reduced to the white list: no field carries contacts of people
 * (contracts 7.2). Unknown stays unknown: a missing salary, tax base or grade is `null`, never a guess.
 */
export interface SourcePosting {
	externalId: string;
	url: string;
	title: string;
	organization: { name: string; inn: string | null; sourceOrgId: string | null };
	publishedAt: string | null;
	updatedAt: string | null;
	salary: {
		min: number | null;
		max: number | null;
		/** ISO 4217. */
		currency: string | null;
		period: SalaryPeriod | null;
		/** `null` — the source does not say; the model stores it as `unknown`. */
		taxBase: 'gross' | 'net' | null;
		rawText: string | null;
	};
	grade: { raw: string } | null;
	location: { city: string | null; remote: boolean | null; raw: string | null };
	employment: { raw: string } | null;
	skillsRaw: string[];
	/** Only when the terms of the source allow storing the text; contacts are cut out before it is returned. */
	description: string | null;
	/** Contacts were found and removed from `description`. */
	contactsRemoved: boolean;
	/** SHA-256 of the source record before the fields were selected. */
	rawSha256: string;
}

export interface SourcePage {
	items: SourcePosting[];
	/** `null` — the last page. */
	nextCursor: string | null;
	/** Version of the listing, when the source reports one. */
	sourceVersion: string | null;
	declaredTotal: number | null;
}

export interface VacancySource {
	/** `vacancy_sources.key`. */
	readonly source: string;
	readonly adapterVersion: string;
	/**
	 * What a `full` listing covers. `snapshot` — every live posting of the imported scope, so a posting absent from a
	 * complete listing is gone; `recent_window` — only the latest postings (a feed), so absence proves nothing and
	 * postings leave only through `get`.
	 */
	readonly listing: 'snapshot' | 'recent_window';
	/**
	 * How the listing is kept to IT. `source` — the adapter filters by the source's own category, every posting it
	 * returns is IT; `taxonomy` — the listing mixes industries, and the import keeps only the postings the taxonomy
	 * recognizes as IT (`it-scope.ts`).
	 */
	readonly itScope: 'source' | 'taxonomy';

	/** A page of postings; the adapter respects the limits of the source. */
	list(input: { mode: 'full' | 'incremental'; since?: string; cursor?: string }): Promise<SourceResult<SourcePage>>;

	/** Freshness check of one posting. */
	get(externalId: string): Promise<SourceResult<SourcePosting | { gone: true }>>;
}
