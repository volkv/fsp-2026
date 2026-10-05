import { error, type RequestEvent } from '@sveltejs/kit';
import { can } from '$lib/server/access/permissions';
import { CATALOG, type GradeKey } from '$lib/server/assessments/contract/catalog';
import type { GradeOption } from '$lib/server/assessments/contract/policy';
import { formText } from '$lib/server/auth/http';
import { candidateDemand } from '$lib/server/candidates/demand';
import { candidateRequest, type CandidateRequest } from '$lib/server/candidates/http';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { candidateObjections, withdrawObjection } from '$lib/server/categories/objections';
import { categoryHistory } from '$lib/server/categories/read';
import { db } from '$lib/server/db';
import { gradeSources } from '$lib/server/grades/sources';
import { loadGradeStanding } from '$lib/server/grades/standing';
import { blockReasonText, optionText } from '$lib/server/grades/texts';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

function nextOption(options: readonly GradeOption[], grade: GradeKey): GradeOption {
	const option = options.find((o) => o.grade === grade);
	if (!option) throw new Error(`the next step names grade ${grade} outside the options`);
	return option;
}

/**
 * «Категория и грейд» (domain 12.3, 12.5, 12.7): the step to a category, the declared and the confirmed grade, the tests
 * the grade policy opens now and why the others are closed, the categories in force and their history, the objections
 * to test results, the history of surveys and declarations, and what the vacancies of the category ask for.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, candidateId } = await candidateRequest(event);
	try {
		const executor = db();
		const now = new Date();
		const [standing, categories, objections, demand, vocabulary] = await Promise.all([
			loadGradeStanding(executor, gradeSources, candidateId, now),
			categoryHistory(executor, candidateId),
			candidateObjections(executor, candidateId),
			candidateDemand(executor, subject, now),
			currentCandidateVocabulary(executor)
		]);
		const next = standing.next;
		return {
			catalog: {
				directions: Object.fromEntries(CATALOG.directions.map((d) => [d.key, d.title])),
				specializations: Object.fromEntries(CATALOG.specializations.map((s) => [s.key, s.title])),
				grades: Object.fromEntries(CATALOG.grades.map((g) => [g.key, g.title])),
				blocks: Object.fromEntries(CATALOG.blocks.map((b) => [b.code, b.title]))
			},
			survey: standing.survey && {
				version: standing.survey.version,
				direction: standing.survey.direction,
				specialization: standing.survey.specialization,
				declaredSkillKeys: standing.survey.declaredSkillKeys
			},
			declaration: standing.declaration && {
				grade: standing.declaration.grade,
				declaredAt: standing.declaration.declaredAt.toISOString()
			},
			category: standing.category && {
				specialization: standing.category.specialization,
				grade: standing.category.grade,
				assignedAt: standing.category.assignedAt.toISOString(),
				confirmedBlocks: [...standing.category.confirmedBlocks]
			},
			steps: standing.steps,
			next: {
				kind: next.kind,
				grade: next.kind === 'test' || next.kind === 'wait' ? next.grade : null,
				text:
					next.kind === 'test'
						? optionText(nextOption(standing.options, next.grade))
						: next.kind === 'wait'
							? blockReasonText(next.reason, next.availableFrom)
							: null
			},
			options: standing.options.map((option) => ({
				grade: option.grade,
				available: option.available,
				text: optionText(option)
			})),
			surveys: standing.surveys
				.map((s) => ({
					version: s.version,
					specialization: s.specialization,
					declaredSkillKeys: s.declaredSkillKeys,
					createdAt: s.createdAt.toISOString()
				}))
				.reverse(),
			declarations: standing.declarations
				.map((d) => ({
					id: d.id,
					specialization: d.specialization,
					grade: d.grade,
					suggested: d.hint.suggested,
					declaredAt: d.declaredAt.toISOString()
				}))
				.reverse(),
			categories,
			objections,
			demand,
			labels: vocabularyLabels(vocabulary)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

/** Withdrawing an objection is the candidate's own write: `candidate.self.write` (domain 12.5). */
async function writer(event: RequestEvent): Promise<CandidateRequest> {
	const request = await candidateRequest(event);
	const access = can(request.subject, 'candidate.self.write', { candidateId: request.candidateId });
	if (!access.allowed) error(403, { message: 'Недостаточно прав', requestId: event.locals.requestId });
	return request;
}

export const actions: Actions = {
	withdraw: async (event) => {
		const { candidateId, userId, meta } = await writer(event);
		const form = await event.request.formData();
		try {
			await withdrawObjection(db(), {
				objectionId: formText(form, 'objectionId'),
				candidateId,
				userId,
				requestId: meta.requestId
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { objectionWithdrawn: true };
	}
};
