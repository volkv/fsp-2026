import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { createChallenge, listChallenges } from '$lib/server/challenges/company';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

const DAY = 86_400_000;

/**
 * Calls of the company (domain 13.12): a short task with the range and the goal in view, delivered regularly to the
 * candidates of its categories; a new one, published at once or kept as a draft.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	try {
		return {
			challenges: await listChallenges(contactPageDeps(), subject),
			names: catalogNames(),
			defaultEndsOn: new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const amount = (value: string) => Number(value.replace(/\s/gu, ''));

export const actions: Actions = {
	create: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		let challengeId: string;
		try {
			const endsOn = formText(form, 'endsOn');
			const created = await createChallenge(contactPageDeps(), subject, meta, {
				title: formText(form, 'title'),
				statement: formText(form, 'statement'),
				answerKind: formText(form, 'answerKind'),
				specialization: formText(form, 'specialization'),
				grades: form.getAll('grades').filter((value): value is string => typeof value === 'string'),
				salaryMin: amount(formText(form, 'salaryMin')),
				salaryMax: amount(formText(form, 'salaryMax')),
				salaryCurrency: 'RUB',
				salaryTaxBase: formText(form, 'salaryTaxBase'),
				goal: formText(form, 'goal'),
				timeLimitMinutes: Number(formText(form, 'timeLimitMinutes')),
				endsAt: new Date(`${endsOn}T21:00:00Z`),
				publish: formText(form, 'publish') === 'on'
			});
			challengeId = created.id;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/challenges/${challengeId}?created=1`);
	}
};
