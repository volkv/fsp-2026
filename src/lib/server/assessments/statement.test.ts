import { describe, expect, it } from 'vitest';
import { parseInline, parseStatement, StatementError } from './statement';

describe('task statement', () => {
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
