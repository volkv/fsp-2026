import { redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { formText } from '$lib/server/http/form';
import { auditActorOf } from '$lib/server/companies/context';
import { sendConsentLetter } from '$lib/server/consent/representative';
import { invalid } from '$lib/server/companies/context';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import {
	AUTHORITY_BASES,
	decideAuthority,
	OPERATOR_AUTHORITY_METHODS,
	representationCase
} from '$lib/server/operator/representatives';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	try {
		return {
			representation: await representationCase(db(), fieldCrypto(), subject, meta, event.params.id, new Date()),
			bases: AUTHORITY_BASES,
			decided: event.url.searchParams.get('decided')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

async function decide(event: Parameters<Actions[string]>[0], result: 'verified' | 'rejected') {
	const { subject, meta } = await operatorRequest(event);
	const form = await event.request.formData();
	const method = OPERATOR_AUTHORITY_METHODS.find((value) => value === formText(form, 'method'));
	const basisKind = AUTHORITY_BASES.find((value) => value === formText(form, 'basisKind'));
	try {
		if (method === undefined || basisKind === undefined) {
			throw invalid([
				...(method === undefined ? [{ path: 'method', code: 'required', message: 'Выберите способ проверки' }] : []),
				...(basisKind === undefined
					? [{ path: 'basisKind', code: 'required', message: 'Выберите основание полномочий' }]
					: [])
			]);
		}
		await decideAuthority(
			db(),
			subject,
			meta,
			event.params.id,
			{
				result,
				method,
				basisKind,
				basisNote: formText(form, 'basisNote'),
				note: formText(form, 'note')
			},
			new Date()
		);
	} catch (cause) {
		return formFailure(cause);
	}
	// The representative has no account: the consents to sign reach them by a letter with a one-time link. A letter
	// that did not leave is journaled; the candidate asks for it again from the profile.
	if (result === 'verified') await sendConsentLetter(await authDeps(), meta, auditActorOf(subject), event.params.id);
	redirect(303, `${event.url.pathname}?decided=${result}`);
}

export const actions: Actions = {
	verify: (event) => decide(event, 'verified'),
	reject: (event) => decide(event, 'rejected')
};
