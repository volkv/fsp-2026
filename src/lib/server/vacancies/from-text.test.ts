import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { fieldsFromItems, missingFields, positionInput, textBlocks } = await import('./from-text');

type Item = Parameters<typeof fieldsFromItems>[0][number];

const quote = { blockId: 'p1', start: 0, end: 1, text: 'x' };
const item = (overrides: Partial<Item>): Item => ({
	kind: 'role_title',
	rawText: '',
	polarity: null,
	modelPolarity: null,
	grade: null,
	value: null,
	salary: null,
	quote,
	...overrides
});

const resolve = (raw: string) =>
	({ python: 'python', java: 'java', postgresql: 'postgresql' })[raw.toLowerCase()] ?? null;
const role = (title: string) => (title.includes('Python') ? 'backend' : null);

describe('vacancy from text', () => {
	it('splits the text into paragraph blocks', () => {
		expect(textBlocks('Python-разработчик\n\n  Требования:  \r\nPython, SQL')).toEqual([
			{ id: 'p1', text: 'Python-разработчик' },
			{ id: 'p2', text: 'Требования:' },
			{ id: 'p3', text: 'Python, SQL' }
		]);
	});

	it('turns items into fields: negated skills are never requirements, uncertain ones are wishes', () => {
		const fields = fieldsFromItems(
			[
				item({ kind: 'role_title', rawText: 'Python-разработчик' }),
				item({ kind: 'required_skill', rawText: 'Python', polarity: 'asserted' }),
				item({ kind: 'required_skill', rawText: 'PostgreSQL', polarity: 'uncertain' }),
				item({ kind: 'required_skill', rawText: 'Java', polarity: 'negated' }),
				item({ kind: 'required_skill', rawText: 'Python', polarity: 'asserted' }),
				item({ kind: 'nice_skill', rawText: 'Kafka', polarity: 'asserted' }),
				item({ kind: 'grade', grade: { min: 'middle', max: 'senior' } }),
				item({
					kind: 'salary',
					salary: { min: 250_000, max: 350_000, currency: 'RUB', period: 'month', taxBase: 'unknown' }
				}),
				item({ kind: 'work_format', value: 'remote' }),
				item({ kind: 'contract_type', value: 'labor' }),
				item({ kind: 'contract_type', value: 'labor' })
			],
			[],
			resolve,
			role
		);
		expect(fields.title?.value).toBe('Python-разработчик');
		expect(fields.roleKey).toBe('backend');
		expect(fields.requiredSkills.map((s) => s.key)).toEqual(['python']);
		expect(fields.niceSkills.map((s) => [s.key, s.raw])).toEqual([
			['postgresql', 'PostgreSQL'],
			[null, 'Kafka']
		]);
		expect(fields.negatedSkills.map((s) => s.key)).toEqual(['java']);
		expect(fields.contractTypes).toHaveLength(1);
		// The text did not state the tax base or the employment form: the employer fills them in.
		expect(missingFields(fields)).toEqual(['employmentForm', 'salary.taxBase']);
	});

	it('splits a mention of alternatives into a skill each and makes a choice a wish, not a requirement', () => {
		const blocks = [
			{ id: 'p1', text: 'Требования: Python или Java, PostgreSQL' },
			{ id: 'p2', text: 'Будет плюсом: Java/PostgreSQL' }
		];
		const at = (blockId: string, text: string) => {
			const block = blocks.find((candidate) => candidate.id === blockId)?.text ?? '';
			const start = block.indexOf(text);
			return { blockId, start, end: start + text.length, text };
		};
		// The model named the choice in one element, then the same names as elements of their own.
		const combined = fieldsFromItems(
			[
				item({
					kind: 'required_skill',
					rawText: 'Python или Java',
					polarity: 'asserted',
					quote: at('p1', 'Python или Java')
				}),
				item({ kind: 'required_skill', rawText: 'PostgreSQL', polarity: 'asserted', quote: at('p1', 'PostgreSQL') })
			],
			blocks,
			resolve,
			role
		);
		expect(combined.requiredSkills.map((s) => s.key)).toEqual(['postgresql']);
		expect(combined.niceSkills.map((s) => [s.key, s.quote.text])).toEqual([
			['python', 'Python или Java'],
			['java', 'Python или Java']
		]);

		const separate = fieldsFromItems(
			[
				item({ kind: 'required_skill', rawText: 'Python', polarity: 'asserted', quote: at('p1', 'Python') }),
				item({ kind: 'required_skill', rawText: 'Java', polarity: 'asserted', quote: at('p1', 'Java') }),
				item({ kind: 'required_skill', rawText: 'PostgreSQL', polarity: 'asserted', quote: at('p1', 'PostgreSQL') })
			],
			blocks,
			resolve,
			role
		);
		expect(separate.requiredSkills.map((s) => s.key)).toEqual(['postgresql']);
		expect(separate.niceSkills.map((s) => s.key)).toEqual(['python', 'java']);

		// A slash names two skills but offers no choice: each keeps the section it was found in.
		const slash = fieldsFromItems(
			[
				item({
					kind: 'required_skill',
					rawText: 'Java/PostgreSQL',
					polarity: 'asserted',
					quote: at('p2', 'Java/PostgreSQL')
				})
			],
			blocks,
			resolve,
			role
		);
		expect(slash.requiredSkills.map((s) => s.key)).toEqual(['java', 'postgresql']);
		expect(slash.niceSkills).toEqual([]);
	});

	it('asks for everything when nothing was extracted', () => {
		expect(missingFields(fieldsFromItems([], [], resolve, role))).toEqual([
			'title',
			'roleKey',
			'grade',
			'workFormat',
			'employmentForm',
			'contractTypes',
			'salary.bounds',
			'salary.currency',
			'salary.period',
			'salary.taxBase'
		]);
	});

	it('compares with the market only the recognized required skills and the range the text states', () => {
		const fields = fieldsFromItems(
			[
				item({ kind: 'role_title', rawText: 'Python-разработчик' }),
				item({ kind: 'required_skill', rawText: 'Python', polarity: 'asserted' }),
				item({ kind: 'required_skill', rawText: 'Cobol', polarity: 'asserted' }),
				item({ kind: 'required_skill', rawText: 'Java', polarity: 'negated' }),
				item({ kind: 'nice_skill', rawText: 'PostgreSQL', polarity: 'asserted' }),
				item({ kind: 'grade', grade: { min: 'middle', max: null } }),
				item({
					kind: 'salary',
					salary: { min: 250_000, max: null, currency: 'RUB', period: 'month', taxBase: 'unknown' }
				})
			],
			[],
			resolve,
			role
		);
		expect(positionInput(fields)).toEqual({
			roleKey: 'backend',
			gradeMin: 'middle',
			gradeMax: null,
			requiredSkillKeys: ['python'],
			// An unknown tax base stays unknown: the comparison says «несравнимо», not a guess.
			salary: { min: 250_000, max: null, currency: 'RUB', period: 'month', taxBase: 'unknown' }
		});

		const silent = positionInput(
			fieldsFromItems([item({ kind: 'role_title', rawText: 'Python-разработчик' })], [], resolve, role)
		);
		expect(silent.salary).toEqual({ min: null, max: null, currency: null, period: null, taxBase: null });
		expect(silent.gradeMin).toBeNull();
	});
});
