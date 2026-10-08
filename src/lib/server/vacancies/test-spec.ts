// «Каким будет тест по этой вакансии» (docs/domain.md, 13.11): the specification of the test read from a vacancy — its
// role gives the specializations, its range the grades, its required and nice-to-have skills the requirements, and the
// lists of requirements of its text the names the taxonomy does not know — against the releases in force. The same
// reading serves a saved vacancy and the draft of a pasted text; the example set is seeded by the text, so the draft
// and the vacancy saved from it show the same set.
import { createHash } from 'node:crypto';
import type { Executor } from '$lib/server/db';
import { openSpecializations, releaseInForce } from '$lib/server/assessments/bank-store';
import {
	vacancyTestSpec,
	type OpenBanks,
	type SpecRequirement,
	type VacancyTestSpec
} from '$lib/server/assessments/vacancy-spec';
import type { SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { SpecInput } from '$lib/server/assessments/vacancy-spec';
import type { FamilyDescriptor } from '$lib/server/assessments/contract/bank';
import { specializationsOfRole } from '$lib/server/categories/roles';
import { unrecognizedRequirements } from '$lib/server/needs/requirements';
import type { Vocabulary } from '$lib/server/employer/vocabulary';
import { textBlocks, type VacancyTextFields } from './from-text';
import { resolveSkill, type VacancyTaxonomy } from './taxonomy';

/** The families of the release in force of every open specialization. */
export async function banksInForce(executor: Executor): Promise<OpenBanks> {
	const banks = new Map<SpecializationKey, readonly FamilyDescriptor[]>();
	for (const specialization of [...(await openSpecializations(executor))].sort()) {
		const release = await releaseInForce(executor, specialization);
		if (!release) throw new Error(`specialization ${specialization} is open without a release in force`);
		banks.set(
			specialization,
			release.families.map((family) => family.descriptor)
		);
	}
	return banks;
}

/** The grades of a range by the order of the taxonomy, both ends included. */
function gradeRange(order: readonly string[], min: string, max: string): string[] {
	const from = order.indexOf(min);
	const to = order.indexOf(max);
	if (from === -1 || to === -1 || from > to)
		throw new Error(`grade range ${min}–${max} is not a range of ${order.join(', ')}`);
	return order.slice(from, to + 1);
}

/**
 * Requirements of the lists of a text that no alias of the taxonomy reads («Hugging Face»): kept by their names, each
 * «тестом не проверяется». A listed item the taxonomy resolves is a skill, the employer's fields decide on it.
 */
function outsideTaxonomy(taxonomy: VacancyTaxonomy, text: string | null): SpecRequirement[] {
	if (text === null || text.trim() === '') return [];
	return unrecognizedRequirements(textBlocks(text), [])
		.filter((item) => resolveSkill(taxonomy, item.name) === null)
		.map((item) => ({ skillKey: null, name: item.name, requirement: item.requirement }));
}

/** Skills of a vacancy or a need by their names in its vocabulary; a key the vocabulary lacks is a data error. */
function skillRequirements(
	vocabulary: Pick<Vocabulary, 'skills'>,
	required: readonly string[],
	nice: readonly string[]
): SpecRequirement[] {
	const names = new Map(vocabulary.skills.map(({ key, name }) => [key, name]));
	const named = (key: string) => {
		const name = names.get(key);
		if (name === undefined) throw new Error(`skill ${key} is not in the vocabulary`);
		return name;
	};
	return [
		...required.map((key) => ({ skillKey: key, name: named(key), requirement: 'required' as const })),
		...nice.map((key) => ({ skillKey: key, name: named(key), requirement: 'nice' as const }))
	];
}

/** The seed of the example set of a text: its SHA-256, so the same text shows the same set. */
export const textSeed = (text: string): string =>
	`text:${createHash('sha256').update(text.trim()).digest('hex').slice(0, 32)}`;

export interface SpecVacancy {
	roleKey: string;
	gradeMin: string;
	gradeMax: string;
	requiredSkillKeys: readonly string[];
	niceSkillKeys: readonly string[];
	description: string;
}

/** What the specification reads from a saved vacancy; `vocabulary` — the version the vacancy was written with. */
export function vacancySpecInput(
	vacancy: SpecVacancy,
	vocabulary: Pick<Vocabulary, 'skills' | 'grades'>,
	taxonomy: VacancyTaxonomy
): SpecInput {
	return {
		specializations: specializationsOfRole(vacancy.roleKey),
		grades: gradeRange(
			vocabulary.grades.map((g) => g.key),
			vacancy.gradeMin,
			vacancy.gradeMax
		),
		requirements: [
			...skillRequirements(vocabulary, vacancy.requiredSkillKeys, vacancy.niceSkillKeys),
			...outsideTaxonomy(taxonomy, vacancy.description)
		],
		seed: textSeed(vacancy.description)
	};
}

/**
 * What the specification reads from the draft of a pasted text, before anything is saved: the suggested role and
 * range, the skills with a key, the skills the taxonomy did not resolve and the listed requirements no alias reads.
 */
function draftSpecInput(
	fields: Pick<VacancyTextFields, 'roleKey' | 'grade' | 'requiredSkills' | 'niceSkills'>,
	text: string,
	vocabulary: Pick<Vocabulary, 'skills' | 'grades'>,
	taxonomy: VacancyTaxonomy
): SpecInput {
	const keyed = (list: VacancyTextFields['requiredSkills']) =>
		list.flatMap((skill) => (skill.key === null ? [] : [skill.key]));
	const unresolved = [
		...fields.requiredSkills
			.filter((s) => s.key === null)
			.map((s) => ({ name: s.raw.trim(), requirement: 'required' as const })),
		...fields.niceSkills
			.filter((s) => s.key === null)
			.map((s) => ({ name: s.raw.trim(), requirement: 'nice' as const }))
	];
	const requirements: SpecRequirement[] = [
		...skillRequirements(vocabulary, keyed(fields.requiredSkills), keyed(fields.niceSkills)),
		...unresolved.map((item) => ({ skillKey: null, ...item }))
	];
	const named = new Set(requirements.map((r) => r.name.toLowerCase()));
	for (const item of outsideTaxonomy(taxonomy, text)) {
		if (named.has(item.name.toLowerCase())) continue;
		named.add(item.name.toLowerCase());
		requirements.push(item);
	}
	const { min, max } = fields.grade?.value ?? { min: null, max: null };
	const low = min ?? max;
	const high = max ?? min;
	return {
		specializations: fields.roleKey === null ? [] : specializationsOfRole(fields.roleKey),
		grades:
			low === null || high === null
				? []
				: gradeRange(
						vocabulary.grades.map((g) => g.key),
						low,
						high
					),
		requirements,
		seed: textSeed(text)
	};
}

/** The specification of the test of a saved vacancy. */
export async function vacancyTestSpecOf(
	executor: Executor,
	vacancy: SpecVacancy,
	vocabulary: Pick<Vocabulary, 'skills' | 'grades'>,
	taxonomy: VacancyTaxonomy
): Promise<VacancyTestSpec> {
	return vacancyTestSpec(vacancySpecInput(vacancy, vocabulary, taxonomy), await banksInForce(executor));
}

/** The specification of the test of the draft of a pasted text; `text` — as the description of the draft keeps it. */
export async function draftTestSpecOf(
	executor: Executor,
	fields: VacancyTextFields,
	text: string,
	vocabulary: Pick<Vocabulary, 'skills' | 'grades'>,
	taxonomy: VacancyTaxonomy
): Promise<VacancyTestSpec> {
	return vacancyTestSpec(draftSpecInput(fields, text, vocabulary, taxonomy), await banksInForce(executor));
}
