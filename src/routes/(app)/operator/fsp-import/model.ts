// Words of the FSP results import page: the codes of the batch reader and of the journal named for the operator.

/** Why a row of a batch was not read, by the code of its issue. */
export const ISSUE_LABELS: Readonly<Record<string, string>> = {
	required: 'Нет обязательного значения',
	invalid_number: 'Не число',
	invalid_date: 'Неверная дата',
	invalid_value: 'Неверное значение',
	unknown_value: 'Значение не сопоставлено',
	cell_error: 'Ошибка в ячейке',
	no_participant: 'Нет участника',
	duplicate_result: 'Повтор результата',
	competition_conflict: 'Соревнование описано иначе',
	athlete_conflict: 'Данные спортсмена расходятся',
	row_shape: 'Строка не по колонкам'
};

/** Why a batch does not speak for every result of its competitions. */
const INCOMPLETE_REASONS: Readonly<Record<string, string>> = {
	not_declared_complete: 'полнота пакета не отмечена',
	row_issues: 'в пакете есть строки с ошибками',
	parser_partial: 'протокол прочитан не полностью'
};

/** Why a batch is not complete, in words; `null` — it is complete. */
export function incompleteText(reason: string | null): string {
	return reason === null ? '' : (INCOMPLETE_REASONS[reason] ?? reason);
}

/** Why an import refused a batch. */
export const REFUSALS: Readonly<Record<string, string>> = {
	row_issues: 'в пакете строки с ошибками',
	taxonomy_missing: 'нет опубликованных справочников'
};

export const FORMAT_LABELS: Readonly<Record<string, string>> = {
	csv: 'CSV',
	xlsx: 'XLSX',
	pdf: 'PDF',
	docx: 'DOCX',
	odt: 'ODT',
	rtf: 'RTF'
};

export const VARIANT_LABELS: Readonly<Record<string, string>> = {
	file: 'выгрузка',
	'pdf-protocols': 'протокол'
};

/** Issues shown in the preview table; the rest are counted. */
export const ISSUES_SHOWN = 200;
