import { formText } from '$lib/server/auth/http';
import { reinstateCompany, suspendCompany, type SuspensionReason } from '$lib/server/companies/verification';
import { invalid } from '$lib/server/companies/context';
import { db } from '$lib/server/db';
import { companyDeps } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { moderationCard } from '$lib/server/operator/companies';
import { operatorRequest } from '$lib/server/operator/http';
import { endPartnershipFromForm, openPartnershipFromForm } from '$lib/server/operator/partnership-forms';
import { allPartnerships, knownCompetitions } from '$lib/server/operator/partnerships';
import { smallCountThreshold } from '$lib/server/operator/small-numbers';
import type { Actions, PageServerLoad } from './$types';

const REASONS: readonly SuspensionReason[] = [
	'authority_revoked',
	'registry_inactive',
	'terms_violation',
	'complaint',
	'company_request'
];

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const now = new Date();
	try {
		const card = await moderationCard(db(), subject, event.params.id);
		const threshold = await smallCountThreshold(db(), now);
		const competitions = await knownCompetitions(db(), subject, threshold);
		return {
			card,
			partnerships: await allPartnerships(companyDeps(), { subject, meta }, threshold, card.id),
			competitions,
			today: now.toISOString().slice(0, 10)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	suspend: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		const reasonCode = REASONS.find((reason) => reason === formText(form, 'reasonCode'));
		try {
			if (!reasonCode) throw invalid([{ path: 'reasonCode', code: 'required', message: 'Выберите причину' }]);
			await suspendCompany(companyDeps(), { subject, meta }, event.params.id, { reasonCode });
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'suspended' as const };
	},
	reinstate: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			await reinstateCompany(companyDeps(), { subject, meta }, event.params.id);
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'reinstated' as const };
	},
	openPartnership: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		form.set('companyId', event.params.id);
		try {
			await openPartnershipFromForm(companyDeps(), { subject, meta }, form);
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'partnership_opened' as const };
	},
	endPartnership: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			await endPartnershipFromForm(companyDeps(), { subject, meta }, await event.request.formData());
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'partnership_ended' as const };
	}
};
