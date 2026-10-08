// «Каким будет тест по этой потребности» (docs/domain.md, 13.10, 13.11): the specification of the test read from the
// form of a need — its specialization, or those of its role; the grades of its range; its skills and the requirements
// outside the taxonomy the employer confirmed — by the same rule as a vacancy.
import type { Executor } from '$lib/server/db';
import { vacancyTestSpec, type SpecRequirement, type VacancyTestSpec } from '$lib/server/assessments/vacancy-spec';
import { specializationsOfRole } from '$lib/server/categories/roles';
import type { Vocabulary } from '$lib/server/employer/vocabulary';
import { banksInForce, textSeed } from '$lib/server/vacancies/test-spec';
import { gradesOf } from './form';
import type { NeedView } from './service';

/**
 * The requirements of the form: a skill by its name in the vocabulary; a key the taxonomy no longer names and a
 * requirement the employer kept by its name are outside the taxonomy — no block checks them.
 */
function requirementsOf(need: NeedView, vocabulary: Pick<Vocabulary, 'skills'>): SpecRequirement[] {
	const names = new Map(vocabulary.skills.map(({ key, name }) => [key, name]));
	const skill = (key: string, requirement: 'required' | 'nice'): SpecRequirement => {
		const name = names.get(key);
		return name === undefined ? { skillKey: null, name: key, requirement } : { skillKey: key, name, requirement };
	};
	const { form } = need;
	return [
		...form.skill_keys.map((key) => skill(key, 'required')),
		...form.nice_skill_keys.map((key) => skill(key, 'nice')),
		...(form.other_skills ?? []).map((name) => ({ skillKey: null, name, requirement: 'required' as const })),
		...(form.other_nice_skills ?? []).map((name) => ({ skillKey: null, name, requirement: 'nice' as const }))
	];
}

/** The specification of the test of a need; `vocabulary` — the current one the form is written against. */
export async function needTestSpecOf(
	executor: Executor,
	need: NeedView,
	vocabulary: Pick<Vocabulary, 'skills'>
): Promise<VacancyTestSpec> {
	const { form } = need;
	const specializations =
		form.specialization !== undefined
			? [form.specialization]
			: form.role_key !== undefined
				? specializationsOfRole(form.role_key)
				: [];
	return vacancyTestSpec(
		{
			specializations,
			grades: form.grade === undefined ? [] : gradesOf(form.grade),
			requirements: requirementsOf(need, vocabulary),
			// The text seeds the example, as for a vacancy; a need of the form only — its id and the moment of its form.
			seed: need.text === null ? `need:${need.id}:${need.updatedAt.toISOString()}` : textSeed(need.text)
		},
		await banksInForce(executor)
	);
}
