import { fail } from '@sveltejs/kit';
import { minorTermsAcceptance } from '$lib/server/companies/profile';
import { formText } from '$lib/server/http/form';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf, vacancyAuthor } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { getOwnVacancy } from '$lib/server/employer/vacancies';
import { readVacancyForm, vacancyFieldMessages, vacancyFormOf, vacancyInput } from '$lib/server/employer/vacancy-form';
import { currentVocabulary, formVocabulary, labelsOf, vocabularyOf } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import {
	closeOwnVacancy,
	pauseOwnVacancy,
	publishOwnVacancy,
	resumeOwnVacancy,
	updateOwnVacancy
} from '$lib/server/vacancies/own';
import { loadVacancyTaxonomy } from '$lib/server/vacancies/taxonomy';
import { vacancyTestSpecOf } from '$lib/server/vacancies/test-spec';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const vacancyDeps = () => ({ db: db(), now: () => new Date() });

export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	try {
		const vacancy = await getOwnVacancy(database, membership.companyId, event.params.id, new Date());
		const [written, current, minorTerms, taxonomy] = await Promise.all([
			vocabularyOf(database, vacancy.taxonomyVersionId),
			currentVocabulary(database),
			minorTermsAcceptance(database, membership.companyId, new Date()),
			loadVacancyTaxonomy(database)
		]);
		const labels = labelsOf(written);
		return {
			vacancy,
			labels,
			testSpec: await vacancyTestSpecOf(database, vacancy, written, taxonomy),
			form: vacancyFormOf(vacancy, labels),
			vocabulary: formVocabulary(current),
			minorTermsAccepted: minorTerms !== null,
			created: event.url.searchParams.has('created')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

type Transition = typeof pauseOwnVacancy;

function transitionAction(run: Transition) {
	return async (event: RequestEvent) => {
		const { subject, meta } = await employerRequest(event);
		try {
			await run(vacancyDeps(), vacancyAuthor(subject, meta), event.params.id);
		} catch (cause) {
			return formFailure(cause);
		}
		return { changed: true };
	};
}

export const actions: Actions = {
	publish: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			const outcome = await publishOwnVacancy(vacancyDeps(), vacancyAuthor(subject, meta), event.params.id, {
				confirmWarnings: form.get('confirmWarnings') === 'on'
			});
			return { published: outcome.status };
		} catch (cause) {
			return formFailure(cause);
		}
	},
	pause: transitionAction(pauseOwnVacancy),
	resume: transitionAction(resumeOwnVacancy),
	close: transitionAction(closeOwnVacancy),

	update: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const values = readVacancyForm(form);
		const database = db();
		try {
			const author = vacancyAuthor(subject, meta);
			const parsed = vacancyInput(
				values,
				await loadVacancyTaxonomy(database),
				labelsOf(await currentVocabulary(database))
			);
			if (!parsed.ok) return fail(400, { values, problems: parsed.fields });
			const row = await updateOwnVacancy(
				{ db: database, now: () => new Date() },
				author,
				event.params.id,
				parsed.input,
				{ confirmWarnings: form.get('confirmWarnings') === 'on' }
			);
			return { updated: true, outcome: updateOutcome(formText(form, 'previousStatus'), row.status) };
		} catch (cause) {
			if (cause instanceof ApiError && cause.code === 'validation_failed') {
				const failure = formFailure(cause);
				return fail(400, { values, problems: vacancyFieldMessages(failure.data.problem.fields) });
			}
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, values });
		}
	}
};

/**
 * What the saved edit did to the moderation of the vacancy, for the message: stayed in moderation, left it for the
 * catalog, the pause or a draft, or nothing to say (`saved`); a blocked text entered or stayed in moderation. The status the form was opened with names only the wording.
 */
function updateOutcome(previousStatus: string, status: string): string {
	if (status === 'pending_moderation') {
		return previousStatus === 'pending_moderation' ? 'stayed_pending' : 'entered_pending';
	}
	if (previousStatus === 'pending_moderation') return `left_${status}`;
	return 'saved';
}
