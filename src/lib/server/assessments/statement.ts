// Task statements are written in a small subset of Markdown and turned into blocks the page renders as elements, so no
// HTML from the bank ever reaches the page. Anything outside the subset is refused when the bank is read.
// Imported by plain Node (through bank.ts): no imports, erasable syntax only.

export type Inline = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'strong'; text: string };

export type StatementBlock =
	| { kind: 'heading'; text: string }
	| { kind: 'paragraph'; inlines: Inline[] }
	| { kind: 'code'; text: string }
	| { kind: 'list'; ordered: boolean; items: Inline[][] };

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
