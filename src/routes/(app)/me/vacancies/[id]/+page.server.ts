import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { formText } from '$lib/server/http/form';
import { applyToVacancy, showcaseVacancyFor } from '$lib/server/applications/service';
import { candidateRequest } from '$lib/server/candidates/http';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { contactPageDeps } from '$lib/server/contact/page';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

const vacancyIdOf = (value: string, requestId: string): string => {
	const parsed = z.uuid().safeParse(value);
	if (!parsed.success) error(404, { message: 'Вакансия не найдена', requestId });
	return parsed.data;
};

/**
 * A vacancy of the showcase (domain 13.5): an own published vacancy of a company of the platform, the candidate's match
 * with it, and the application — with the contacts the candidate chooses to disclose to that company.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	const vacancyId = vacancyIdOf(event.params.id, event.locals.requestId);
	try {
		const [card, vocabulary] = await Promise.all([
			showcaseVacancyFor(contactPageDeps(), subject, vacancyId),
			currentCandidateVocabulary(db())
		]);
		return { card, labels: vocabularyLabels(vocabulary) };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	apply: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const vacancyId = vacancyIdOf(event.params.id, event.locals.requestId);
		const form = await event.request.formData();
		try {
			await applyToVacancy(contactPageDeps(), subject, meta, {
				vacancyId,
				message: formText(form, 'message'),
				discloseFields: form.getAll('disclose_fields').filter((value): value is string => typeof value === 'string'),
				disclosureDocumentId: formText(form, 'disclosureDocumentId')
			});
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, '/me/applications?sent=1');
	}
};
