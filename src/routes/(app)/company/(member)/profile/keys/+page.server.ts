import { PERMISSIONS, type Permission } from '$lib/server/access/permissions';
import { formText } from '$lib/server/http/form';
import { createApiKey, listApiKeys, revokeApiKey } from '$lib/server/companies/api-keys';
import { companyDeps, employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/** Permissions an owner may hand to a key: allowed for keys and held by the owner's role. */
const GRANTABLE = (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => {
	const spec = PERMISSIONS[permission];
	return spec.apiKey && (spec.roles as readonly string[]).includes('owner');
});

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	try {
		return {
			keys: await listApiKeys(companyDeps(), { subject, meta }, membership.companyId),
			grantable: GRANTABLE
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	create: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const membership = membershipOf(event, subject);
		const form = await event.request.formData();
		const expires = formText(form, 'expiresAt');
		try {
			const { key, token } = await createApiKey(companyDeps(), { subject, meta }, membership.companyId, {
				name: formText(form, 'name'),
				permissions: form.getAll('permissions').filter((value): value is string => typeof value === 'string'),
				// The key stops working at the end of the chosen day (Moscow time, the product zone).
				expiresAt: expires === '' ? null : new Date(`${expires}T23:59:59+03:00`)
			});
			// The secret is shown once, in this answer only; the server keeps its hash.
			return { created: { name: key.name, token } };
		} catch (cause) {
			return formFailure(cause);
		}
	},

	revoke: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			await revokeApiKey(companyDeps(), { subject, meta }, formText(form, 'keyId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { revoked: true };
	}
};
