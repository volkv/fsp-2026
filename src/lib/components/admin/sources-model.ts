// Words of the vacancy sources page for the codes of the import journal and the queue. A code without a word is shown
// as the code itself.
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Counters of an import run, in the order the page shows them. */
export const RUN_COUNTS: readonly {
	key: 'fetched' | 'created' | 'updated' | 'unchanged' | 'gone' | 'reappeared';
	label: string;
}[] = [
	{ key: 'fetched', label: 'получено' },
	{ key: 'created', label: 'новых' },
	{ key: 'updated', label: 'изменилось' },
	{ key: 'unchanged', label: 'без изменений' },
	{ key: 'gone', label: 'снято' },
	{ key: 'reappeared', label: 'вернулось' }
];

/** Why postings of a run were not stored. */
export const REJECTED_REASONS: Record<string, string> = {
	duplicate_in_listing: 'повтор в ленте',
	missing_title_or_organization: 'без названия или работодателя',
	not_it: 'не ИТ-вакансия'
};

/** Why a run is partial: a feed of latest postings or an incremental listing is partial by nature, not by failure. */
export const INCOMPLETE_REASONS: Record<string, string> = {
	recent_window_listing: 'лента содержит только свежие публикации',
	incremental: 'инкрементальный импорт',
	source_version_changed: 'выгрузка источника обновилась во время чтения',
	source_unavailable: 'источник недоступен',
	source_rate_limited: 'источник ограничил частоту запросов',
	source_forbidden: 'источник отказал по правам или условиям',
	source_protocol_error: 'ответ источника не по контракту',
	source_disabled: 'источник выключили во время импорта',
	abandoned: 'обработчик остановился, не закончив',
	page_limit: 'достигнут предел страниц'
};

/** The latest import job of a source. */
export const JOB_STATUSES: Record<string, { label: string; tone: Tone }> = {
	queued: { label: 'импорт в очереди', tone: 'info' },
	running: { label: 'импорт идёт', tone: 'info' },
	succeeded: { label: 'импорт выполнен', tone: 'success' },
	discarded_stale: { label: 'импорт заменён более новым', tone: 'neutral' },
	failed: { label: 'импорт не удался', tone: 'danger' },
	cancelled: { label: 'импорт отменён', tone: 'neutral' }
};

/** Error codes of the import job (`vacancies/import-job.ts`). */
export const JOB_ERRORS: Record<string, string> = {
	source_unavailable: 'источник недоступен',
	source_rate_limited: 'источник ограничил частоту запросов',
	source_forbidden: 'источник отказал по правам или условиям — выключен',
	source_protocol_error: 'ответ источника не по контракту',
	source_unknown: 'источник не зарегистрирован',
	adapter_missing: 'у источника нет адаптера',
	taxonomy_missing: 'справочники таксономии не опубликованы'
};

export function everyHours(hours: number): string {
	return hours === 1 ? 'каждый час' : `каждые ${hours} ч`;
}
