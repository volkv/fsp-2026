import { describe, expect, it } from 'vitest';
import { BGE_M3_Q8, spaceDefinition } from './definitions';
import { fitText, MAX_INPUT_CHARS, profileSections, type ProfileFacts } from './text';

const empty: ProfileFacts = { skills: [], experience: [], desiredRoles: [], competitions: [], adult: true };

describe('fitText', () => {
	it('keeps a short text and cuts a long one at the last whitespace before the limit', () => {
		expect(fitText('  Go, Kafka  ')).toBe('Go, Kafka');
		expect(fitText('alpha beta gamma', 12)).toBe('alpha beta');
		expect(fitText('x'.repeat(20), 8)).toBe('x'.repeat(8));
		expect(fitText('word '.repeat(400)).length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
	});
});

describe('profileSections', () => {
	it('gives no section for an empty profile', () => {
		expect(profileSections(empty)).toEqual([]);
	});

	it('builds the three sections in a fixed order from the same facts in any order', () => {
		const facts: ProfileFacts = {
			skills: ['Go', 'PostgreSQL', 'Go', 'Kafka'],
			experience: [
				{ role: 'Аналитик данных', years: { from: 2019, to: 2020 }, skills: ['SQL'] },
				{ role: 'Backend-разработчик', years: { from: 2021, to: null }, skills: ['Kafka', 'Go'] }
			],
			desiredRoles: ['Backend-разработчик'],
			competitions: [
				{ discipline: 'algorithmic', level: 'regional_cup', award: 'participant', online: true },
				{ discipline: 'product', level: 'russian_cup', award: 'prize', online: false }
			],
			adult: true
		};
		const sections = profileSections(facts);
		expect(sections).toEqual([
			{ section: 'skills', text: 'Навыки: Go, Kafka, PostgreSQL' },
			{
				section: 'experience',
				text:
					'Опыт работы: Backend-разработчик, с 2021 по настоящее время; навыки: Go, Kafka\n' +
					'Аналитик данных, 2019–2020; навыки: SQL'
			},
			{
				section: 'summary',
				text:
					'Желаемые роли: Backend-разработчик\n' +
					'Соревнования ФСП: Программирование продуктовое — Кубок России, призёр, очно; ' +
					'Программирование алгоритмическое — Кубок субъекта, участник, онлайн'
			}
		]);
		const shuffled: ProfileFacts = {
			...facts,
			skills: [...facts.skills].reverse(),
			experience: [...facts.experience].reverse(),
			competitions: [...facts.competitions].reverse()
		};
		expect(profileSections(shuffled)).toEqual(sections);
	});

	it('shows a minor the results without their group and format, as the catalog card does', () => {
		const [summary] = profileSections({
			...empty,
			competitions: [{ discipline: 'product', level: 'russian_cup', award: 'winner', online: false }],
			adult: false
		});
		expect(summary?.text).toBe('Соревнования ФСП: Программирование продуктовое — Кубок России');
	});

	it('keeps every section within the input limit, dropping the least mentioned skills and the oldest experience', () => {
		const skills = Array.from({ length: 300 }, (_, i) => `Навык ${String(i).padStart(3, '0')}`);
		const sections = profileSections({
			...empty,
			skills: ['Главный', 'Главный', ...skills],
			experience: Array.from({ length: 60 }, (_, i) => ({
				role: `Роль ${i}`,
				years: { from: 1960 + i, to: 1961 + i },
				skills: ['Go']
			})),
			competitions: Array.from({ length: 80 }, (_, i) => ({
				discipline: 'product',
				level: 'municipal',
				award: 'participant',
				online: i % 2 === 0
			}))
		});
		for (const section of sections) expect(section.text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
		expect(sections.find((s) => s.section === 'skills')?.text).toMatch(/^Навыки: Главный, Навык 000, /);
		const experience = sections.find((s) => s.section === 'experience')?.text ?? '';
		expect(experience).toContain('Роль 59, 2019–2020');
		expect(experience).not.toContain('Роль 0,');
	});
});

describe('space definitions', () => {
	it('derive the identifier from every parameter of the space', () => {
		expect(BGE_M3_Q8.id).toBe('bge-m3@aa473d51f451/q:none/d:none/cls/l2/1024/t512/sections-v1');
		expect(spaceDefinition(BGE_M3_Q8.id)).toBe(BGE_M3_Q8);
		expect(spaceDefinition('bge-m3@other/q:none/d:none/cls/l2/1024/t512/sections-v1')).toBeNull();
	});
});
