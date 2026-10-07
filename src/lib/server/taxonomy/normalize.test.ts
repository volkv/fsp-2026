import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSkillIndex, matchSkill, normalizeSkillText, type SkillIndex } from './normalize';
import { buildRelease, readTaxonomyDatasets } from './release';

const TAXONOMY_DIR = fileURLToPath(new URL('../../../../taxonomy', import.meta.url));

describe('normalizeSkillText', () => {
	it('folds case, ё, dashes, underscores and spacing', () => {
		expect(normalizeSkillText('  Spring_Boot ')).toBe('spring boot');
		expect(normalizeSkillText('React‑Native')).toBe('react native');
		expect(normalizeSkillText('Ёжик\tв  тумане')).toBe('ежик в тумане');
	});

	it('keeps significant punctuation and drops sentence punctuation', () => {
		expect(normalizeSkillText('C++')).toBe('c++');
		expect(normalizeSkillText('C#,')).toBe('c#');
		expect(normalizeSkillText('.NET')).toBe('.net');
		expect(normalizeSkillText('(Node.js).')).toBe('node.js');
		expect(normalizeSkillText('«Go»')).toBe('go');
	});
});

describe('matchSkill on a synthetic index', () => {
	const index = buildSkillIndex([
		{ aliasNormalized: 'mysql', skillKey: 'mysql' },
		{ aliasNormalized: 'mssql', skillKey: 'mssql' },
		{ aliasNormalized: 'kubernetes', skillKey: 'kubernetes' },
		{ aliasNormalized: 'k8s', skillKey: 'kubernetes' },
		{ aliasNormalized: 'c', skillKey: 'c' },
		{ aliasNormalized: 'r', skillKey: 'r' }
	]);

	it('resolves an exact alias', () => {
		expect(matchSkill(index, 'K8S')).toEqual({
			method: 'alias',
			skillKey: 'kubernetes',
			score: 1,
			normalized: 'k8s',
			alternatives: []
		});
	});

	it('resolves a typo above the threshold', () => {
		expect(matchSkill(index, 'Kubernetis')).toMatchObject({ method: 'fuzzy', skillKey: 'kubernetes', score: 0.9 });
	});

	it('refuses a mention equally close to two skills and keeps both as alternatives', () => {
		expect(matchSkill(index, 'mxsql')).toEqual({
			method: 'unknown',
			skillKey: null,
			score: 0.8,
			normalized: 'mxsql',
			alternatives: [
				{ skillKey: 'mssql', score: 0.8 },
				{ skillKey: 'mysql', score: 0.8 }
			]
		});
	});

	it('does not guess short names', () => {
		expect(matchSkill(index, 'q')).toMatchObject({ method: 'unknown', skillKey: null, alternatives: [] });
	});

	it('keeps an unknown mention as its normalized text', () => {
		expect(matchSkill(index, '  Blorptech ')).toEqual({
			method: 'unknown',
			skillKey: null,
			score: null,
			normalized: 'blorptech',
			alternatives: []
		});
	});

	it('rejects an alias owned by two skills', () => {
		expect(() =>
			buildSkillIndex([
				{ aliasNormalized: 'go', skillKey: 'go' },
				{ aliasNormalized: 'go', skillKey: 'gogs' }
			])
		).toThrow(/belongs to both go and gogs/);
	});

	it('rejects an alias that is not normalized', () => {
		expect(() => buildSkillIndex([{ aliasNormalized: 'Go', skillKey: 'go' }])).toThrow(/not in normalized form/);
	});
});

describe('matchSkill on the release dictionary', () => {
	let index: SkillIndex;

	beforeAll(async () => {
		const release = buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR));
		index = buildSkillIndex(
			release.content.skillAliases.map((a) => ({ aliasNormalized: a.alias_normalized, skillKey: a.skill_key }))
		);
	});

	it.each([
		['Golang', 'go'],
		['JS', 'javascript'],
		['джаваскрипт', 'javascript'],
		['кубернетес', 'kubernetes'],
		['Postgres', 'postgresql'],
		['.NET Core', 'dotnet'],
		['Node.js', 'nodejs']
	])('maps the synonym %s to %s', (raw, skillKey) => {
		expect(matchSkill(index, raw)).toMatchObject({ method: 'alias', skillKey });
	});

	// Skill spellings of vacancies the taxonomy did not recognize before release 2026.09.7.
	it.each([
		['Базы данных', 'databases'],
		['JSON', 'json'],
		['XML', 'xml'],
		['SOAP', 'soap'],
		['DNS', 'networking'],
		['TCP', 'networking'],
		['TCP/IP', 'networking'],
		['Zabbix', 'zabbix'],
		['ITIL', 'itil'],
		['Высоконагруженные системы', 'system_design'],
		['Техподдержка', 'technical_support'],
		['Техническая поддержка', 'technical_support'],
		['Администрирование серверов', 'server_administration'],
		['Pre-sale', 'presale']
	])('maps the spelling %s to %s', (raw, skillKey) => {
		expect(matchSkill(index, raw)).toMatchObject({ method: 'alias', skillKey });
	});

	it('keeps C, C++, C#, Java and JavaScript apart', () => {
		const keys = ['C', 'C++', 'C#', 'Java', 'JavaScript'].map((raw) => matchSkill(index, raw).skillKey);
		expect(keys).toEqual(['c', 'cpp', 'csharp', 'java', 'javascript']);
	});

	it.each([
		['javascrpit', 'javascript'],
		['Kubernetis', 'kubernetes'],
		['pyhton', 'python'],
		['elasticsaerch', 'elasticsearch']
	])('corrects the typo %s to %s', (raw, skillKey) => {
		expect(matchSkill(index, raw)).toMatchObject({ method: 'fuzzy', skillKey });
	});

	it('refuses a typo equally close to MySQL and MS SQL', () => {
		const match = matchSkill(index, 'mxsql');
		expect(match).toMatchObject({ method: 'unknown', skillKey: null });
		expect(match.alternatives.map((a) => a.skillKey)).toEqual(['mssql', 'mysql']);
	});
});
