import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import {
	decideVerification,
	REVIEW_DUE_HOURS,
	verificationCase,
	type VerificationDecision
} from '$lib/server/companies/verification';
import { db } from '$lib/server/db';
import { companyDeps } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { applicantEmailDomain, registryRecordOf } from '$lib/server/operator/companies';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const deps = companyDeps();
	try {
		const verification = await verificationCase(deps, { subject, meta }, event.params.id);
		return {
			now: new Date(),
			dueAt: new Date(verification.submittedAt.getTime() + REVIEW_DUE_HOURS * 3_600_000),
			verification,
			registryRecord: registryRecordOf(verification.company.registrySnapshot),
			applicantDomain: await applicantEmailDomain(db(), deps.crypto, verification.applicant.memberId),
			decided: event.url.searchParams.get('decided')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

/** An optional requisite the operator confirmed; an empty field keeps what the owner entered. */
const confirmed = (value: string) => (value.trim() === '' ? undefined : value.replace(/\s/g, ''));

async function decide(
	event: Parameters<Actions[string]>[0],
	build: (form: FormData) => VerificationDecision
): Promise<ReturnType<typeof formFailure>> {
	const { subject, meta } = await operatorRequest(event);
	const form = await event.request.formData();
	const decision = build(form);
	try {
		await decideVerification(companyDeps(), { subject, meta }, event.params.id, decision);
	} catch (cause) {
		return formFailure(cause);
	}
	redirect(303, `${event.url.pathname}?decided=${decision.kind}`);
}

export const actions: Actions = {
	approve: (event) =>
		decide(event, (form) => {
			const legalName = formText(form, 'legalName').trim();
			const ogrn = confirmed(formText(form, 'ogrn'));
			const kpp = confirmed(formText(form, 'kpp'));
			return {
				kind: 'approve',
				requisites: {
					...(legalName === '' ? {} : { legalName }),
					...(ogrn === undefined ? {} : { ogrn }),
					...(kpp === undefined ? {} : { kpp })
				}
			};
		}),
	reject: (event) => decide(event, (form) => ({ kind: 'reject', reason: formText(form, 'reason') })),
	requestInfo: (event) => decide(event, (form) => ({ kind: 'request_info', reason: formText(form, 'reason') }))
};
