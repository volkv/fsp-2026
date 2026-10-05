import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	CATALOG,
	SANDBOX_LANGUAGE_KEYS,
	blockDefinition,
	confirmedStack,
	gradeDefinition,
	practiceWritesCode,
	specializationOpen,
	type Catalog,
	type GradeDefinition
} from './catalog';
import { GRADE_POLICY } from './policy';
import { PROCEDURE } from './procedure';
import { catalogProblems, policyProblems, procedureProblems } from './validate';

const SKILLS_FILE = fileURLToPath(new URL('../../../../../taxonomy/skills.json', import.meta.url));
const LANGUAGES_FILE = fileURLToPath(new URL('../../../../../services/sandbox/languages.json', import.meta.url));

let skills: Set<string>;

beforeAll(async () => {
	const taxonomy = JSON.parse(await readFile(SKILLS_FILE, 'utf8')) as { skills: { key: string }[] };
	skills = new Set(taxonomy.skills.map((skill) => skill.key));
});

/** The catalog with one definition replaced. */
function withDefinition(
	specialization: string,
	grade: string,
	change: (definition: GradeDefinition) => GradeDefinition
): Catalog {
	return {
		...CATALOG,
		definitions: CATALOG.definitions.map((d) =>
			d.specialization === specialization && d.grade === grade ? change(d) : d
		)
	};
}

describe('catalog', () => {
	it('is valid against the procedure and the taxonomy', () => {
		expect(catalogProblems(CATALOG, PROCEDURE, skills)).toEqual([]);
	});

	it('names the language set of the sandbox image', async () => {
		const image = JSON.parse(await readFile(LANGUAGES_FILE, 'utf8')) as { languages: { key: string }[] };
		expect(image.languages.map((language) => language.key).sort()).toEqual([...SANDBOX_LANGUAGE_KEYS].sort());
	});

	it('refuses quotas that do not fill the longest trajectory', () => {
		const broken = withDefinition('backend', 'middle', (d) => ({
			...d,
			blocks: d.blocks.map((q) => (q.block === 'be.db' ? { ...q, items: q.items - 1 } : q))
		}));
		expect(catalogProblems(broken, PROCEDURE, skills)).toEqual([
			'catalog: backend × middle quotas sum to 17, the longest trajectory is 18'
		]);
	});

	it('refuses a block of another specialization, a missing pair and a practice slot after the minimum', () => {
		const foreign = withDefinition('qa', 'junior', (d) => ({
			...d,
			blocks: d.blocks.map((q) => (q.block === 'qa.sql' ? { ...q, block: 'ds.sql' } : q))
		}));
		expect(catalogProblems(foreign, PROCEDURE, skills)).toContain('catalog: qa × junior names ds.sql of data_ml');

		const missing: Catalog = {
			...CATALOG,
			definitions: CATALOG.definitions.filter((d) => !(d.specialization === 'devops' && d.grade === 'senior'))
		};
		expect(catalogProblems(missing, PROCEDURE, skills)).toContain('catalog: devops × senior has 0 definitions');

		const late = withDefinition('frontend', 'intern', (d) => ({ ...d, practice: { ...d.practice, position: 8 } }));
		expect(catalogProblems(late, PROCEDURE, skills)).toEqual([
			'catalog: frontend × intern practice at slot 8, after the minimum of 6 items'
		]);
	});

	it('requires the change step from Middle up and only there', () => {
		const off = withDefinition('data_ml', 'senior', (d) => ({ ...d, practice: { ...d.practice, changeStep: false } }));
		expect(catalogProblems(off, PROCEDURE, skills)).toEqual(['catalog: data_ml × senior change step must be on']);
		const on = withDefinition('mobile', 'junior', (d) => ({ ...d, practice: { ...d.practice, changeStep: true } }));
		expect(catalogProblems(on, PROCEDURE, skills)).toEqual(['catalog: mobile × junior change step must be off']);
	});

	it('refuses a skill unknown to the taxonomy and a practice format outside a practice block', () => {
		const broken: Catalog = {
			...CATALOG,
			blocks: CATALOG.blocks.map((b) =>
				b.code === 'be.db'
					? { ...b, skillKeys: [...b.skillKeys, 'cobol'], formats: [...b.formats, 'practice_code'] }
					: b
			)
		};
		expect(catalogProblems(broken, PROCEDURE, skills)).toEqual([
			'catalog: be.db names skill cobol unknown to the taxonomy',
			'catalog: block be.db is not practice but has practice_code'
		]);
	});

	it('requires two defining blocks of the plan with enough items each', () => {
		const thin = withDefinition('backend', 'intern', (d) => ({ ...d, defining: ['be.lang', 'be.api'] }));
		expect(catalogProblems(thin, PROCEDURE, skills)).toEqual([
			'catalog: backend × intern defining block be.api has 1 items, 3 required'
		]);
		const foreign = withDefinition('backend', 'intern', (d) => ({ ...d, defining: ['be.lang', 'be.code'] }));
		expect(catalogProblems(foreign, PROCEDURE, skills)).toEqual([
			'catalog: backend × intern defining block be.code is not a non-practice block of the plan'
		]);
	});

	it('does not switch on a specialization whose practice language the sandbox lacks ', () => {
		const on: Catalog = {
			...CATALOG,
			specializations: CATALOG.specializations.map((s) => (s.key === 'mobile' ? { ...s, availability: 'enabled' } : s))
		};
		const withoutKotlin = SANDBOX_LANGUAGE_KEYS.filter((key) => key !== 'kotlin');
		expect(catalogProblems(on, PROCEDURE, skills, withoutKotlin)).toEqual([
			'catalog: mobile is enabled, but the sandbox image lacks kotlin'
		]);
	});

	it('confirms the stack of the defining blocks and the practice language, whatever the length', () => {
		expect(confirmedStack(gradeDefinition('backend', 'middle'), 'go')).toEqual([
			'databases',
			'go',
			'multithreading',
			'sql'
		]);
	});

	it('confirms no language of a QA practice: the candidate wrote test cases, the harness language is not theirs', () => {
		const qa = gradeDefinition('qa', 'junior');
		expect(practiceWritesCode(qa)).toBe(false);
		expect(practiceWritesCode(gradeDefinition('backend', 'junior'))).toBe(true);
		const defining = [...new Set(qa.defining.flatMap((code) => blockDefinition(code).skillKeys))].sort();
		expect(confirmedStack(qa, null)).toEqual(defining);
		expect(confirmedStack(qa, null)).not.toContain('python');
		expect(() => confirmedStack(qa, 'python3')).toThrow(/no language is confirmed/);
		expect(confirmedStack(gradeDefinition('backend', 'middle'), null)).not.toContain('go');
	});

	it('refuses a shape outside the schema', () => {
		const broken: Catalog = { ...CATALOG, version: 'october' };
		expect(catalogProblems(broken, PROCEDURE, skills)[0]).toMatch(/^catalog\.version: /);
	});

	it('opens a specialization only when switched on and released', () => {
		expect(specializationOpen('backend', new Set(['backend']))).toBe(true);
		expect(specializationOpen('backend', new Set())).toBe(false);
		expect(specializationOpen('mobile', new Set(['mobile']))).toBe(false);
	});
});

describe('procedure and policy parameters', () => {
	it('are valid', () => {
		expect(procedureProblems(PROCEDURE)).toEqual([]);
		expect(policyProblems(GRADE_POLICY)).toEqual([]);
	});

	it('refuse broken values', () => {
		expect(
			procedureProblems({
				...PROCEDURE,
				alpha: 0.7,
				grades: { ...PROCEDURE.grades, junior: { nMin: 9, nMax: 8, extension: 2 } }
			})
		).toEqual(['procedure.alpha: Too big: expected number to be <0.5', 'procedure.grades.junior: nMin > nMax']);
		expect(policyProblems({ ...GRADE_POLICY, retakeIntervalDays: 200 })).toEqual([
			'policy: the retake interval is not shorter than the window of forms'
		]);
	});
});
