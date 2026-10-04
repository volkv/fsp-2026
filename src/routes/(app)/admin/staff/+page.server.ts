import { standChangesLocked } from '$lib/server/access/demo-actor';
import { adminRequest, staffDeps } from '$lib/server/admin/http';
import {
	auditReadFromForm,
	findUser,
	grantFromForm,
	grantStaffRole,
	revokeFromForm,
	revokeStaffRole,
	setOperatorAuditRead,
	staffList,
	type UserCard
} from '$lib/server/admin/staff';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { ApiError } from '$lib/server/errors/api-error';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	const query = event.url.searchParams.get('q')?.trim() ?? '';
	let found: UserCard | null = null;
	let searchProblem: string | null = null;
	try {
		if (query !== '') {
			try {
				found = await findUser(staffDeps(), ctx, query);
			} catch (cause) {
				// A query that cannot be an address or an id is a problem of the search field, shown next to it.
				if (!(cause instanceof ApiError) || cause.code !== 'validation_failed') throw cause;
				searchProblem = cause.details?.[0]?.message ?? cause.message;
			}
		}
		return {
			query,
			found,
			searchProblem,
			staff: await staffList(staffDeps(), ctx),
			demoLocked: await standChangesLocked(db(), ctx.subject)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	grant: async (event) => {
		const ctx = await adminRequest(event);
		try {
			await grantStaffRole(staffDeps(), ctx, grantFromForm(await event.request.formData()));
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'granted' as const };
	},
	revoke: async (event) => {
		const ctx = await adminRequest(event);
		try {
			await revokeStaffRole(staffDeps(), ctx, revokeFromForm(await event.request.formData()));
		} catch (cause) {
			return formFailure(cause);
		}
		return { done: 'revoked' as const };
	},
	auditRead: async (event) => {
		const ctx = await adminRequest(event);
		try {
			const input = auditReadFromForm(await event.request.formData());
			await setOperatorAuditRead(staffDeps(), ctx, input);
			return { done: input.enabled ? ('audit_granted' as const) : ('audit_revoked' as const) };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
