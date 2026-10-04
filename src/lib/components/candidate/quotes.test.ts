import { describe, expect, it } from 'vitest';
import { documentView, parseQuote, parseQuotes, resumeFieldOf, type ResumeQuote } from './quotes';

// «🚀» and «𝔾» lie outside the BMP: one code point, two UTF-16 units each. Offsets below are code points.
const TEXT = '🚀 Анна\nНавыки: 𝔾o, Python и Go\nОпыт 🚀 2021';
const BLOCKS = [
	{ id: 'p1-b001', page: 1, kind: 'heading', column: null, start: 0, end: 6 },
	{ id: 'p1-b002', page: 1, kind: 'paragraph', column: null, start: 7, end: 30 },
	{ id: 'p2-b003', page: 2, kind: 'line', column: null, start: 31, end: 42 }
];
const document = { extractionId: 'x1', text: TEXT, blocks: BLOCKS };

const quote = (blockId: string, start: number, end: number, text: string): ResumeQuote => ({
	extractionId: 'x1',
	blockId,
	start,
	end,
	text
});

describe('stored quotes', () => {
	it('reads the stored shape', () => {
		expect(parseQuote({ extraction_id: 'x1', block_id: 'p1-b002', start: 12, end: 18, text: 'Python' })).toEqual(
			quote('p1-b002', 12, 18, 'Python')
		);
		expect(parseQuotes([{ extraction_id: 'x1', block_id: 'p1-b001', start: 2, end: 6, text: 'Анна' }])).toHaveLength(1);
	});

	it('refuses another shape instead of showing no quote', () => {
		expect(() => parseQuote(null)).toThrow(/resume quote/);
		expect(() => parseQuote({ extraction_id: 'x1', block_id: 'p1-b002', start: 5, end: 5, text: 'x' })).toThrow();
		expect(() => parseQuote({ blockId: 'p1-b002', start: 0, end: 1, text: 'x' })).toThrow();
		expect(() => parseQuotes({})).toThrow(/resume quotes/);
	});
});

describe('document view', () => {
	it('cuts blocks by code points, not by UTF-16 units', () => {
		const view = documentView(document, []);
		expect(view.blocks.map((block) => block.segments.map((s) => s.text).join(''))).toEqual([
			'🚀 Анна',
			'Навыки: 𝔾o, Python и Go',
			'Опыт 🚀 2021'
		]);
		expect(view.blocks.map((block) => block.page)).toEqual([1, 1, 2]);
	});

	it('marks a quote after characters outside the BMP at its words', () => {
		const view = documentView(document, [
			{ key: 'claim:python', quotes: [quote('p1-b002', 12, 18, 'Python')] },
			{ key: 'claim:name', quotes: [quote('p1-b001', 2, 6, 'Анна')] },
			{ key: 'claim:year', quotes: [quote('p2-b003', 7, 11, '2021')] }
		]);
		const marked = view.blocks.map((block) => block.segments.filter((s) => s.keys.length > 0).map((s) => s.text));
		expect(marked).toEqual([['Анна'], ['Python'], ['2021']]);
		expect(view.blocks[1]?.segments).toEqual([
			{ text: 'Навыки: 𝔾o, ', keys: [] },
			{ text: 'Python', keys: ['claim:python'] },
			{ text: ' и Go', keys: [] }
		]);
		expect(view.located.sort()).toEqual(['claim:name', 'claim:python', 'claim:year']);
	});

	it('splits overlapping quotes so each piece knows every source covering it', () => {
		const view = documentView(document, [
			{ key: 'entry:e1', quotes: [quote('p1-b002', 8, 21, '𝔾o, Python и ')] },
			{ key: 'claim:python', quotes: [quote('p1-b002', 12, 18, 'Python')] }
		]);
		expect(view.blocks[1]?.segments).toEqual([
			{ text: 'Навыки: ', keys: [] },
			{ text: '𝔾o, ', keys: ['entry:e1'] },
			{ text: 'Python', keys: ['entry:e1', 'claim:python'] },
			{ text: ' и ', keys: ['entry:e1'] },
			{ text: 'Go', keys: [] }
		]);
	});

	it('leaves quotes of another reading unplaced', () => {
		const view = documentView(document, [
			{ key: 'claim:old', quotes: [{ ...quote('p1-b002', 12, 18, 'Python'), extractionId: 'x0' }] }
		]);
		expect(view.located).toEqual([]);
		expect(view.blocks.every((block) => block.segments.every((s) => s.keys.length === 0))).toBe(true);
	});

	it('fails on a quote that does not match its block', () => {
		expect(() => documentView(document, [{ key: 'claim:a', quotes: [quote('p1-b002', 11, 17, 'Python')] }])).toThrow(
			/differs/
		);
		expect(() => documentView(document, [{ key: 'claim:b', quotes: [quote('p1-b404', 0, 1, 'Н')] }])).toThrow(
			/missing/
		);
		expect(() => documentView(document, [{ key: 'claim:c', quotes: [quote('p1-b001', 2, 9, 'Анна')] }])).toThrow(
			/outside/
		);
		expect(() => documentView({ ...document, blocks: [{ id: 'p1-b001' }] }, [])).toThrow(/document blocks/);
	});
});

describe('the field a contribution of the resume rests on', () => {
	const claim = (id: string, claimType: string, experienceEntryId: string | null, text: string) => ({
		id,
		claimType,
		rawText: text,
		polarity: 'asserted',
		skillKey: null,
		value: null,
		quote: quote('p1-b002', 12, 18, text),
		extractor: 'rules',
		candidateReview: 'pending',
		experienceEntryId,
		sourceKey: `claim:${id}`
	});
	const entry = {
		id: 'e1',
		positionTitle: 'Разработчик',
		roleKey: null,
		organizationName: null,
		periodFrom: null,
		periodTo: null,
		periodFromPrecision: null,
		periodToPrecision: null,
		isCurrent: false,
		periodStatus: 'missing',
		appliedSkillKeys: [],
		quotes: [],
		candidateReview: 'pending',
		sourceKey: 'entry:e1'
	};
	const resume = {
		claims: [claim('c1', 'skill_mention', 'e1', 'Python'), claim('c2', 'role_title', 'e1', 'Разработчик')],
		experience: [entry],
		document: { blocks: [], located: ['claim:c1'] }
	};

	it('opens the mention itself, selectable when its quote is in the text', () => {
		expect(resumeFieldOf(resume, { claimId: 'c1', experienceEntryId: 'e1' })).toEqual({
			sourceKey: 'claim:c1',
			title: '«Python»',
			located: true
		});
	});

	it('opens the experience entry for its applied skills and for a field the entry shows', () => {
		expect(resumeFieldOf(resume, { claimId: null, experienceEntryId: 'e1' })).toEqual({
			sourceKey: 'entry:e1',
			title: 'Разработчик',
			located: false
		});
		expect(resumeFieldOf(resume, { claimId: 'c2', experienceEntryId: null })?.sourceKey).toBe('entry:e1');
	});

	it('has no field for a resume the page does not list or a claim of an earlier upload', () => {
		expect(resumeFieldOf(resume, { claimId: 'gone', experienceEntryId: null })).toBeNull();
		expect(resumeFieldOf({ ...resume, document: null }, { claimId: 'c1', experienceEntryId: 'e1' })).toBeNull();
	});
});
