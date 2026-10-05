import { formText } from '$lib/server/auth/http';
import { acceptMinorTerms, companyOverview, minorTermsOf, updateCompanyDraft } from '$lib/server/companies/profile';
import { companyProfileFor, updateCompanyProfile } from '$lib/server/companies/public-profile';
import { companyTrust } from '$lib/server/companies/trust';
import { submitForVerification } from '$lib/server/companies/verification';
import { db } from '$lib/server/db';
import { companyDeps, employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const transferred = event.url.searchParams.has('transferred');
	try {
		const profile = await companyProfileFor(db(), subject, membership.companyId);
		// The facts candidates read next to the profile; the profile read above checked the membership.
		const trust = await companyTrust(db(), membership.companyId, new Date());
		if (membership.role !== 'owner') return { overview: null, minorTerms: null, profile, trust, transferred };
		const deps = companyDeps();
		return {
			overview: await companyOverview(deps, { subject, meta }, membership.companyId),
			minorTerms: await minorTermsOf(deps, { subject, meta }, membership.companyId),
			profile,
			trust,
			transferred
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

/** An optional requisite: an empty field clears it. */
const optional = (value: string) => (value.trim() === '' ? null : value);

export const actions: Actions = {
	/** The owner fills in what the candidate reads about the company in an offer (domain 5.1, 13.5). */
	profile: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const membership = membershipOf(event, subject);
		const form = await event.request.formData();
		try {
			await updateCompanyProfile(companyDeps(), { subject, meta }, membership.companyId, {
				description: formText(form, 'description'),
				activity: formText(form, 'activity'),
				contacts: {
					website: formText(form, 'website'),
					email: formText(form, 'email'),
					phone: formText(form, 'phone'),
					telegram: formText(form, 'telegram')
				}
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { profileSaved: true };
	},

	update: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const membership = membershipOf(event, subject);
		const form = await event.request.formData();
		try {
			await updateCompanyDraft(companyDeps(), { subject, meta }, membership.companyId, {
				displayName: formText(form, 'displayName'),
				legalName: formText(form, 'legalName'),
				inn: formText(form, 'inn').replace(/\s/g, ''),
				ogrn: optional(formText(form, 'ogrn').replace(/\s/g, '')),
				kpp: optional(formText(form, 'kpp').replace(/\s/g, ''))
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { saved: true };
	},

	/** The owner accepts the version of the offer on the work of minors that the page showed. */
	acceptMinorTerms: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const membership = membershipOf(event, subject);
		const form = await event.request.formData();
		try {
			await acceptMinorTerms(companyDeps(), { subject, meta }, membership.companyId, formText(form, 'documentId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { minorTermsAccepted: true };
	},

	submit: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const membership = membershipOf(event, subject);
		try {
			// A corporate address is checked by the operator without a document; the other methods need an uploaded file.
			await submitForVerification(companyDeps(), { subject, meta }, membership.companyId, {
				authorityMethod: 'corporate_email_domain',
				authorityEvidenceFileId: null
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { submitted: true };
	}
};
