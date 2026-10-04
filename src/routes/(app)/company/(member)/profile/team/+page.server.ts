import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import {
	inviteMember,
	listMembers,
	removeMember,
	setMemberRole,
	transferOwnership,
	type MemberRole
} from '$lib/server/companies/members';
import { companyDeps, employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	try {
		return {
			members: await listMembers(companyDeps(), { subject, meta }, membership.companyId),
			selfMemberId: membership.memberId
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

function roleOf(event: RequestEvent, value: string): MemberRole {
	if (value !== 'owner' && value !== 'recruiter') {
		error(400, { message: 'Неизвестная роль', requestId: event.locals.requestId });
	}
	return value;
}

export const actions: Actions = {
	invite: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const membership = membershipOf(event, subject);
		const form = await event.request.formData();
		const email = formText(form, 'email');
		try {
			const result = await inviteMember(companyDeps(), { subject, meta }, membership.companyId, {
				email,
				role: roleOf(event, formText(form, 'role'))
			});
			return { invited: { letterSent: result.letterSent } };
		} catch (cause) {
			return formFailure(cause);
		}
	},

	role: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			await setMemberRole(
				companyDeps(),
				{ subject, meta },
				formText(form, 'memberId'),
				roleOf(event, formText(form, 'role'))
			);
		} catch (cause) {
			return formFailure(cause);
		}
		return { changed: true };
	},

	remove: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			await removeMember(companyDeps(), { subject, meta }, formText(form, 'memberId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { removed: true };
	},

	transfer: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			await transferOwnership(companyDeps(), { subject, meta }, formText(form, 'memberId'));
		} catch (cause) {
			return formFailure(cause);
		}
		// The former owner is a recruiter now: the team is no longer theirs to manage.
		redirect(303, '/company/profile?transferred=1');
	}
};
