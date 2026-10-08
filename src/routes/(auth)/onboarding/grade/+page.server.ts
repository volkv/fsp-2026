import { redirect } from '@sveltejs/kit';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { CATEGORY_GRADE_NAMES } from '$lib/server/categories/labels';
import { formText } from '$lib/server/http/form';
import { db } from '$lib/server/db';
import { computeGradeHint, declareGrade } from '$lib/server/grades/declarations';
import { gradeCandidate } from '$lib/server/grades/http';
import { currentDeclaration } from '$lib/server/grades/policy';
import { gradeSources } from '$lib/server/grades/sources';
import { latestSurvey } from '$lib/server/grades/surveys';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/**
 * The grade hint and the declaration (domain 12.2): the hint advises with its grounds, the candidate chooses; each grade
 * shows its borderline candidate and what its test checks. After the declaration — the way to the test.
 */
export const load: PageServerLoad = async (event) => {
	const { candidateId } = await gradeCandidate(event);
	const executor = db();
	const survey = await latestSurvey(executor, candidateId);
	if (!survey) redirect(303, '/onboarding/survey');
	try {
		const now = new Date();
		const [hint, declaration] = await Promise.all([
			computeGradeHint(executor, candidateId, survey.specialization, now),
			currentDeclaration(executor, candidateId, survey.specialization)
		]);
		const specialization = CATALOG.specializations.find((s) => s.key === survey.specialization);
		if (!specialization) throw new Error(`survey ${survey.id} names a specialization outside the catalog`);
		const blockTitle = new Map(CATALOG.blocks.map((b) => [b.code, b.title]));
		return {
			specialization: { key: specialization.key, title: specialization.title },
			hint,
			declared: declaration?.grade ?? null,
			justDeclared: event.url.searchParams.has('declared'),
			grades: CATALOG.grades.map((grade) => {
				const definition = CATALOG.definitions.find(
					(d) => d.specialization === survey.specialization && d.grade === grade.key
				);
				if (!definition) throw new Error(`catalog has no definition of ${survey.specialization} × ${grade.key}`);
				return {
					key: grade.key,
					title: CATEGORY_GRADE_NAMES[grade.key],
					borderline: definition.borderline,
					blocks: definition.blocks.map((b) => blockTitle.get(b.block) ?? b.block)
				};
			})
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const { subject, candidateId, meta } = await gradeCandidate(event);
		const form = await event.request.formData();
		const survey = await latestSurvey(db(), candidateId);
		if (!survey) redirect(303, '/onboarding/survey');
		try {
			await declareGrade(
				db(),
				gradeSources,
				subject,
				{ specialization: survey.specialization, grade: formText(form, 'grade') },
				meta,
				new Date()
			);
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, '/onboarding/grade?declared');
	}
};
