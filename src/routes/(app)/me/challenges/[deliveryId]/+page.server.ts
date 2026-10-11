import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { formText } from '$lib/server/http/form';
import {
	dismissDelivery,
	myChallenges,
	openDelivery,
	submitSolution,
	withdrawSolution
} from '$lib/server/challenges/candidate';
import { candidateRequest } from '$lib/server/candidates/http';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

const deliveryIdOf = (value: string, requestId: string): string => {
	const parsed = z.uuid().safeParse(value);
	if (!parsed.success) error(404, { message: 'Задание не найдено', requestId });
	return parsed.data;
};

/**
 * One call delivered to the candidate (domain 13.12): the statement, the range, the goal and the time; the solution or
 * the approach, its withdrawal. Opening the page in the browser marks the call opened (a preload of the link does not)
 * — that does not refresh the profile.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	const deliveryId = deliveryIdOf(event.params.deliveryId, event.locals.requestId);
	try {
		const delivery = (await myChallenges(contactPageDeps(), subject)).find((item) => item.deliveryId === deliveryId);
		if (!delivery) error(404, { message: 'Задание не найдено', requestId: event.locals.requestId });
		return { delivery, names: catalogNames() };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	viewed: async (event) => {
		const { subject } = await candidateRequest(event);
		const deliveryId = deliveryIdOf(event.params.deliveryId, event.locals.requestId);
		try {
			await openDelivery(contactPageDeps(), subject, deliveryId);
		} catch (cause) {
			return formFailure(cause);
		}
		return { viewed: true };
	},
	solve: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const deliveryId = deliveryIdOf(event.params.deliveryId, event.locals.requestId);
		const form = await event.request.formData();
		try {
			await submitSolution(contactPageDeps(), subject, meta, deliveryId, formText(form, 'content'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { solved: true };
	},
	withdraw: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const deliveryId = deliveryIdOf(event.params.deliveryId, event.locals.requestId);
		const form = await event.request.formData();
		try {
			await withdrawSolution(contactPageDeps(), subject, meta, deliveryId, formText(form, 'solutionId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { withdrawn: true };
	},
	dismiss: async (event) => {
		const { subject } = await candidateRequest(event);
		const deliveryId = deliveryIdOf(event.params.deliveryId, event.locals.requestId);
		try {
			await dismissDelivery(contactPageDeps(), subject, deliveryId);
		} catch (cause) {
			return formFailure(cause);
		}
		return { dismissed: true };
	}
};
