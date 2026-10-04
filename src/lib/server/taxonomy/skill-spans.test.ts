import { describe, expect, it } from 'vitest';
import { normalizeSkillText } from './normalize';
import { buildSkillReader, skillSpans } from './skill-spans';

const SKILLS: Record<string, string[]> = {
	python: ['Python'],
	go: ['Go', 'Golang', 'го'],
	postgresql: ['PostgreSQL', 'Postgres'],
	nextjs: ['Next.js'],
	cpp: ['C++'],
	ci_cd: ['CI/CD'],
	r: ['R'],
	docker: ['Docker'],
	jetpack_compose: ['Jetpack Compose', 'compose'],
	ui: ['UI-дизайн', 'UI'],
	java: ['Java'],
	spring: ['Spring Framework', 'Spring'],
	kubernetes: ['Kubernetes', 'k8s'],
	pandas: ['Pandas'],
	pandoc: ['Pandoc'],
	prometheus: ['Prometheus', 'мониторинг']
};

const reader = buildSkillReader(
	Object.entries(SKILLS).flatMap(([skillKey, spellings]) =>
		spellings.map((spelling) => ({ aliasNormalized: normalizeSkillText(spelling), skillKey }))
	)
);

const spans = (text: string, wrapped = false) => skillSpans(text, reader, wrapped).map((span) => span.text);

describe('skill spans', () => {
	it('takes aliases as whole tokens with their punctuation', () => {
		expect(spans('Next.js, C++, CI/CD, R, го и Postgres')).toEqual(['Next.js', 'C++', 'CI/CD', 'R', 'Postgres']);
		expect(spans('Python-разработчик')).toEqual(['Python']);
		expect(spans('go to the market')).toEqual([]);
	});

	it('takes a misspelled name only when it stands alone and one skill is close to it', () => {
		expect(spans('Администрирование Kuberentes, Pnadas')).toEqual(['Kuberentes', 'Pnadas']);
		// Equally close to Pandas and Pandoc: a refusal, not a guess.
		expect(spans('Отчёты в Pandos')).toEqual([]);
		// A word of an English phrase and an inflected Russian word are language, not misspelled names.
		expect(spans('Manual testing')).toEqual([]);
		expect(spans('Настройка мониторинга')).toEqual([]);
		// A typo joined to another name as a two-word phrase is part of that name, not a misspelling standing alone.
		expect(spans('Docker Kuberentes')).toEqual(['Docker']);
	});

	it('does not take a shortened name that is a part of another name', () => {
		expect(spans('Сервисы на Docker Compose и Jetpack Compose')).toEqual(['Docker', 'Jetpack Compose']);
		expect(spans('Экраны на Compose')).toEqual(['Compose']);
		expect(spans('UI-тесты на Java Spring')).toEqual(['Java', 'Spring']);
		expect(spans('UI и UI-дизайн')).toEqual(['UI', 'UI-дизайн']);
	});

	it('reads a line break inside one entry as a wrap and between list lines as a separator', () => {
		expect(spans('Сервисы на Docker\nCompose', true)).toEqual(['Docker']);
		expect(spans('Docker\nCompose')).toEqual(['Docker', 'Compose']);
	});
});
