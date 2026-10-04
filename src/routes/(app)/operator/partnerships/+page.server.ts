import { db } from '$lib/server/db';
import { companyDeps } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { verifiedCompanies } from '$lib/server/operator/companies';
import { operatorRequest } from '$lib/server/operator/http';
import { endPartnershipFromForm, openPartnershipFromForm } from '$lib/server/operator/partnership-forms';
import { allPartnerships, knownCompetitions } from '$lib/server/operator/partnerships';
import { smallCountThreshold } from '$lib/server/operator/small-numbers';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const now = new Date();
	try {
		const threshold = await smallCountThreshold(db(), now);
		return {
			partnerships: await allPartnerships(companyDeps(), { subject, meta }, threshold),
			competitions: await knownCompetitions(db(), subject, threshold),
			companies: await verifiedCompanies(db(), subject),
			threshold,
			today: now.toISOString().slice(0, 10)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	openPartnership: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			await openPartnershipFromForm(companyDeps(), { subject, meta }, await event.request.formData());
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'opened' as const };
	},
	endPartnership: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			await endPartnershipFromForm(companyDeps(), { subject, meta }, await event.request.formData());
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'ended' as const };
	}
};
