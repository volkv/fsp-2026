// Task statements are written in a small subset of Markdown and turned into blocks the page renders as elements, so no
// HTML from the bank ever reaches the page. Anything outside the subset is refused when the bank is read.
// Imported by plain Node (through release.ts): no imports, erasable syntax only.

export type Inline = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'strong'; text: string };

export type StatementBlock =
	| { kind: 'heading'; text: string }
	| { kind: 'paragraph'; inlines: Inline[] }
	| { kind: 'code'; text: string }
	| { kind: 'list'; ordered: boolean; items: Inline[][] }
	| { kind: 'table'; header: Inline[][]; rows: Inline[][][] };

export class StatementError extends Error {
	override name = 'StatementError';
}

/** `code` spans and **strong** text; a marker without its pair is refused. */
export function parseInline(text: string): Inline[] {
	const inlines: Inline[] = [];
	let rest = text;
	while (rest.length > 0) {
		const code = rest.indexOf('`');
		const strong = rest.indexOf('**');
		const next = [code, strong].filter((index) => index >= 0);
		if (next.length === 0) {
			inlines.push({ kind: 'text', text: rest });
			break;
		}
		const at = Math.min(...next);
		if (at > 0) inlines.push({ kind: 'text', text: rest.slice(0, at) });
		const marker = at === code ? '`' : '**';
		const close = rest.indexOf(marker, at + marker.length);
		if (close < 0) throw new StatementError(`unpaired ${marker} in: ${text}`);
		inlines.push({ kind: marker === '`' ? 'code' : 'strong', text: rest.slice(at + marker.length, close) });
		rest = rest.slice(close + marker.length);
	}
	return inlines;
}

const BULLET = /^- (.+)$/;
const NUMBERED = /^\d+\. (.+)$/;
const DELIMITER_CELL = /^:?-+:?$/;

/** The cells of a table row `| a | b |`: split on `|` outside `code` spans, each cell trimmed. */
function tableCells(line: string): string[] {
	const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells: string[] = [];
	let cell = '';
	let inCode = false;
	for (const char of body) {
		if (char === '`') inCode = !inCode;
		if (char === '|' && !inCode) {
			cells.push(cell.trim());
			cell = '';
		} else cell += char;
	}
	cells.push(cell.trim());
	return cells;
}

/**
 * A table: the header row, the delimiter row (`---`, alignment colons ignored) and body rows, every row with as many
 * cells as the header; cells take the inline markup of a paragraph.
 */
function parseTable(lines: readonly string[], start: number): { block: StatementBlock; end: number } {
	const header = tableCells(lines[start] ?? '');
	const delimiter = tableCells(lines[start + 1] ?? '');
	if (delimiter.length !== header.length || !delimiter.every((cell) => DELIMITER_CELL.test(cell))) {
		throw new StatementError(`a table at line ${start + 1} needs a delimiter row of ${header.length} cells`);
	}
	const rows: Inline[][][] = [];
	let index = start + 2;
	while (index < lines.length && (lines[index] ?? '').startsWith('|')) {
		const cells = tableCells(lines[index] ?? '');
		if (cells.length !== header.length) {
			throw new StatementError(`table row at line ${index + 1} has ${cells.length} cells, not ${header.length}`);
		}
		rows.push(cells.map(parseInline));
		index++;
	}
	return { block: { kind: 'table', header: header.map(parseInline), rows }, end: index };
}

export function parseStatement(source: string): StatementBlock[] {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const blocks: StatementBlock[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? '';
		if (line.trim() === '') {
			index++;
			continue;
		}
		if (line.startsWith('```')) {
			const end = lines.indexOf('```', index + 1);
			if (end < 0) throw new StatementError(`unclosed code block at line ${index + 1}`);
			blocks.push({ kind: 'code', text: lines.slice(index + 1, end).join('\n') });
			index = end + 1;
			continue;
		}
		if (line.startsWith('## ')) {
			blocks.push({ kind: 'heading', text: line.slice(3).trim() });
			index++;
			continue;
		}
		if (line.startsWith('|')) {
			const table = parseTable(lines, index);
			blocks.push(table.block);
			index = table.end;
			continue;
		}
		if (/^\s/.test(line) || line.startsWith('#')) {
			throw new StatementError(`unsupported construct at line ${index + 1}: ${line}`);
		}
		const bullet = BULLET.test(line);
		if (bullet || NUMBERED.test(line)) {
			const pattern = bullet ? BULLET : NUMBERED;
			const items: Inline[][] = [];
			while (index < lines.length && pattern.test(lines[index] ?? '')) {
				items.push(parseInline(pattern.exec(lines[index] ?? '')?.[1] ?? ''));
				index++;
			}
			blocks.push({ kind: 'list', ordered: !bullet, items });
			continue;
		}
		const paragraph: string[] = [];
		while (index < lines.length) {
			const current = lines[index] ?? '';
			if (
				current.trim() === '' ||
				current.startsWith('```') ||
				current.startsWith('#') ||
				current.startsWith('|') ||
				BULLET.test(current) ||
				NUMBERED.test(current)
			) {
				break;
			}
			paragraph.push(current.trim());
			index++;
		}
		blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
	}
	return blocks;
}
