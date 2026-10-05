import { formText } from '$lib/server/auth/http';
import {
	consentOverview,
	grantCatalogVisibility,
	grantPartnerPoolConsent,
	partnerPoolOverview,
	revokeCatalogVisibility,
	revokePartnerPoolConsent
} from '$lib/server/candidates/consents';
import { candidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { db } from '$lib/server/db';
import { ApiError } from '$lib/server/errors/api-error';
import { invitationDeps } from '$lib/server/invitations/deps';
import { revokeDisclosureConsent } from '$lib/server/invitations/disclosure';
import {
	blockCompany,
	findCompaniesToBlock,
	listBlockedCompanies,
	unblockCompany
} from '$lib/server/profile/company-blocks';
import type { Actions, PageServerLoad } from './$types';

/**
 * Who sees the profile and on which grounds: the catalog consent with its extra blocks, the pools of competition
 * partners by competition, disclosed contacts, what a company sees of each field before and after a disclosure, and
 * the companies the candidate hides from (`?company=` searches the companies to add).
 */
export const load: PageServerLoad = async (event) => {
	const { candidateId } = await candidateRequest(event);
	const now = new Date();
	const query = event.url.searchParams.get('company') ?? '';
	try {
		return {
			overview: await consentOverview(db(), candidateId, now),
			partnerPool: await partnerPoolOverview(db(), candidateId, now),
			blocked: await listBlockedCompanies(db(), candidateId),
			companyQuery: query,
			companyOptions: await findCompaniesToBlock(db(), candidateId, query)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const optional = (value: string) => (value.trim() === '' ? undefined : value.trim());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blockDeps = () => ({ db: db(), now: () => new Date() });

export const actions: Actions = {
	catalogGrant: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await grantCatalogVisibility(db(), subject, meta, {
				documentId: formText(form, 'documentId'),
				scopeFields: form.getAll('scope_fields').filter((value): value is string => typeof value === 'string')
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { catalogSaved: true };
	},

	catalogRevoke: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await revokeCatalogVisibility(db(), subject, meta, optional(formText(form, 'reason')));
		} catch (cause) {
			return formFailure(cause);
		}
		return { catalogRevoked: true };
	},

	poolGrant: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const competitionRef = formText(form, 'competitionRef');
		try {
			await grantPartnerPoolConsent(db(), subject, meta, {
				documentId: formText(form, 'documentId'),
				competitionRef
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { poolGranted: competitionRef };
	},

	poolRevoke: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const competitionRef = formText(form, 'competitionRef');
		try {
			await revokePartnerPoolConsent(db(), subject, meta, competitionRef);
		} catch (cause) {
			return formFailure(cause);
		}
		return { poolRevoked: competitionRef };
	},

	blockCompany: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const companyId = formText(form, 'companyId');
		try {
			if (!UUID.test(companyId)) throw new ApiError('not_found');
			await blockCompany(blockDeps(), subject, meta, companyId);
		} catch (cause) {
			return formFailure(cause);
		}
		return { companyBlocked: true };
	},

	unblockCompany: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const companyId = formText(form, 'companyId');
		try {
			if (!UUID.test(companyId)) throw new ApiError('not_found');
			await unblockCompany(blockDeps(), subject, meta, companyId);
		} catch (cause) {
			return formFailure(cause);
		}
		return { companyUnblocked: true };
	},

	disclosureRevoke: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await revokeDisclosureConsent(invitationDeps(), subject, meta, formText(form, 'invitationId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { disclosureRevoked: true };
	}
};
