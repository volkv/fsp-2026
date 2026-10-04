// CSV of a results export (RFC 4180 with the habits of spreadsheet exports: a byte order mark, «;» as the separator,
// Windows-1251 from older office suites). Quoted fields may hold separators, quotes and line breaks; a row is
// numbered by the line it starts on, as a spreadsheet opened from the file shows it.
import { BatchFormatError, TABLE_LIMITS, type SourceRow, type SourceTable } from './table';

const DELIMITERS = [';', ',', '\t'] as const;
type Delimiter = (typeof DELIMITERS)[number];

function decode(bytes: Uint8Array, encoding: 'utf-8' | 'windows-1251'): string {
	try {
		// `fatal` refuses a file in another encoding instead of replacing its letters with U+FFFD.
		return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch (error) {
		if (error instanceof TypeError) {
			throw new BatchFormatError(
				'unsupported_format',
				`файл не в кодировке ${encoding} (задайте csv.encoding в профиле)`
			);
		}
		throw error;
	}
}

const count = new Intl.NumberFormat('ru-RU');

const limitExceeded = (message: string) => new BatchFormatError('limit_exceeded', message);

interface CsvRecord {
	line: number;
	cells: string[];
}

/** Records of the file; limits are checked as the text is read, so a file beyond them is refused early. */
function records(text: string, delimiter: Delimiter): CsvRecord[] {
	const out: CsvRecord[] = [];
	let cells: string[] = [];
	let cell = '';
	let quoted = false;
	let line = 1;
	let start = 1;
	let i = 0;
	let held = 0;
	const endCell = () => {
		if (cell.length > TABLE_LIMITS.cellChars) {
			throw limitExceeded(`строка ${start}: в поле больше ${count.format(TABLE_LIMITS.cellChars)} символов`);
		}
		if (cells.length === TABLE_LIMITS.columns) {
			throw limitExceeded(`строка ${start}: больше ${TABLE_LIMITS.columns} колонок`);
		}
		if (++held > TABLE_LIMITS.cells) {
			throw limitExceeded(`в файле больше ${count.format(TABLE_LIMITS.cells)} ячеек: разделите пакет на части`);
		}
		cells.push(cell);
		cell = '';
	};
	const endRecord = () => {
		endCell();
		if (out.length === TABLE_LIMITS.rows) {
			throw limitExceeded(`в файле больше ${count.format(TABLE_LIMITS.rows)} строк: разделите пакет на части`);
		}
		out.push({ line: start, cells });
		cells = [];
	};
	while (i < text.length) {
		const ch = text[i] as string;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i += 2;
					continue;
				}
				quoted = false;
			} else {
				if (ch === '\n') line++;
				cell += ch;
			}
			i++;
			continue;
		}
		if (ch === '"' && cell === '') {
			quoted = true;
		} else if (ch === '"') {
			throw new BatchFormatError('unsupported_format', `строка ${line}: кавычка внутри поля без кавычек`);
		} else if (ch === delimiter) {
			endCell();
		} else if (ch === '\r' || ch === '\n') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			endRecord();
			line++;
			start = line;
		} else {
			cell += ch;
		}
		i++;
	}
	if (quoted) throw new BatchFormatError('unsupported_format', `строка ${start}: поле в кавычках не закрыто`);
	if (cell !== '' || cells.length > 0) endRecord();
	return out;
}

/** The separator of the file: the one that occurs most often outside quotes in its first lines. */
function detectDelimiter(text: string): Delimiter {
	const head = text
		.split(/\r?\n/, 20)
		.join('\n')
		.replace(/"[^"]*"/g, '');
	const counts = DELIMITERS.map((d) => ({ d, n: head.split(d).length - 1 }));
	counts.sort((a, b) => b.n - a.n);
	const [best, second] = counts;
	if (!best || best.n === 0 || (second && second.n === best.n)) {
		throw new BatchFormatError(
			'unsupported_format',
			'не удалось определить разделитель CSV (задайте csv.delimiter в профиле)'
		);
	}
	return best.d;
}

export function readCsv(
	bytes: Uint8Array,
	options: { encoding: 'utf-8' | 'windows-1251'; delimiter?: Delimiter; headerRow: number }
): SourceTable {
	const text = decode(bytes, options.encoding);
	const all = records(text, options.delimiter ?? detectDelimiter(text));
	const blank = (r: CsvRecord) => r.cells.every((c) => c.trim() === '');
	const headerRecord = all[options.headerRow - 1];
	if (!headerRecord || blank(headerRecord)) {
		throw new BatchFormatError(
			'mapping_required',
			`в строке ${options.headerRow} CSV нет заголовка (проверьте headerRow профиля)`
		);
	}
	const rows: SourceRow[] = all
		.slice(options.headerRow)
		.filter((r) => !blank(r))
		.map((r) => ({ number: r.line, cells: r.cells }));
	return { header: headerRecord.cells, rows };
}
