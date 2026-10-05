import { describe, expect, it } from 'vitest';
import { parseInline, parseStatement, StatementError } from './statement';

describe('task statement', () => {
	it('reads a table: header, delimiter with alignment, rows of inline cells, a pipe inside code kept', () => {
		const blocks = parseStatement(
			'Запросы:\n\n| # | запрос | заголовки |\n|:---|:---:|---:|\n| 1 | `GET /a` | — |\n| 2 | `x | y` | **есть** |\n\nКонец.'
		);
		expect(blocks).toEqual([
			{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'Запросы:' }] },
			{
				kind: 'table',
				header: [
					[{ kind: 'text', text: '#' }],
					[{ kind: 'text', text: 'запрос' }],
					[{ kind: 'text', text: 'заголовки' }]
				],
				rows: [
					[[{ kind: 'text', text: '1' }], [{ kind: 'code', text: 'GET /a' }], [{ kind: 'text', text: '—' }]],
					[[{ kind: 'text', text: '2' }], [{ kind: 'code', text: 'x | y' }], [{ kind: 'strong', text: 'есть' }]]
				]
			},
			{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'Конец.' }] }
		]);
		// A table right under a paragraph line is not glued into it.
		expect(parseStatement('Текст\n| a |\n|---|\n| 1 |').map((b) => b.kind)).toEqual(['paragraph', 'table']);
	});

	it('refuses a table without its delimiter row or with a row of another width', () => {
		expect(() => parseStatement('| a | b |\n| 1 | 2 |')).toThrow(StatementError);
		expect(() => parseStatement('| a | b |\n|---|---|\n| 1 |')).toThrow(/has 1 cells, not 2/);
	});

	it('turns the subset into blocks without HTML', () => {
		const blocks = parseStatement(
			'Первый абзац\nпродолжается `код` и **важно**.\n\n## Вход\n\n- один\n- два `x`\n\n1. раз\n2. два\n\n```\n<b>1 2</b>\n```\n'
		);
		expect(blocks).toEqual([
			{
				kind: 'paragraph',
				inlines: [
					{ kind: 'text', text: 'Первый абзац продолжается ' },
					{ kind: 'code', text: 'код' },
					{ kind: 'text', text: ' и ' },
					{ kind: 'strong', text: 'важно' },
					{ kind: 'text', text: '.' }
				]
			},
			{ kind: 'heading', text: 'Вход' },
			{
				kind: 'list',
				ordered: false,
				items: [
					[{ kind: 'text', text: 'один' }],
					[
						{ kind: 'text', text: 'два ' },
						{ kind: 'code', text: 'x' }
					]
				]
			},
			{ kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'раз' }], [{ kind: 'text', text: 'два' }]] },
			{ kind: 'code', text: '<b>1 2</b>' }
		]);
	});

	it('refuses what it cannot render faithfully', () => {
		expect(() => parseStatement('```\nno end')).toThrow(StatementError);
		expect(() => parseStatement('- item\n   - nested')).toThrow(StatementError);
		expect(() => parseStatement('# top heading')).toThrow(StatementError);
		expect(() => parseInline('a `b')).toThrow(StatementError);
	});
});
