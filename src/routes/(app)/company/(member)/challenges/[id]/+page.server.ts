import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { formText } from '$lib/server/http/form';
import { challengeSolutionsOf, dismissSolution, updateChallenge } from '$lib/server/challenges/company';
import { advanceDemoClock, demoClockOf } from '$lib/server/challenges/deliver';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

const challengeIdOf = (value: string, requestId: string): string => {
	const parsed = z.uuid().safeParse(value);
	if (!parsed.success) error(404, { message: 'Задание не найдено', requestId });
	return parsed.data;
};

/**
 * One call of the company (domain 13.12): its terms, how it was delivered, the solutions by pseudonym — the company
 * invites from a solution by an offer that names it in «why you», or sets it aside. In a demo session the visitor may
 * move the clock of the session a week on to see the next cycle of delivery at once.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	const challengeId = challengeIdOf(event.params.id, event.locals.requestId);
	try {
		const found = await challengeSolutionsOf(contactPageDeps(), subject, challengeId);
		return {
			...found,
			names: catalogNames(),
			created: event.url.searchParams.has('created'),
			demoClockSeconds: subject.userId === null ? null : await demoClockOf(db(), subject.userId)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	publish: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const challengeId = challengeIdOf(event.params.id, event.locals.requestId);
		try {
			await updateChallenge(contactPageDeps(), subject, meta, challengeId, { status: 'active' });
		} catch (cause) {
			return formFailure(cause);
		}
		return { published: true };
	},
	close: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const challengeId = challengeIdOf(event.params.id, event.locals.requestId);
		try {
			await updateChallenge(contactPageDeps(), subject, meta, challengeId, { status: 'closed' });
		} catch (cause) {
			return formFailure(cause);
		}
		return { closed: true };
	},
	dismiss: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const challengeId = challengeIdOf(event.params.id, event.locals.requestId);
		const form = await event.request.formData();
		try {
			await dismissSolution(contactPageDeps(), subject, meta, challengeId, formText(form, 'solutionId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { dismissed: true };
	},
	/** «Промотать неделю» of a demo session: the calls of its companies run on the clock a week ahead. */
	advanceClock: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		try {
			const advanced = await advanceDemoClock(db(), subject, meta, new Date());
			return { advanced: advanced.runs.reduce((sum, run) => sum + run.delivered, 0) };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
