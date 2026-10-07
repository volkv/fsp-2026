import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import { invalid } from '$lib/server/companies/context';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import {
	AGE_CHECK_METHODS,
	AGE_DOCUMENT_KINDS,
	ageCase,
	resolveAgeConflict,
	type AgeDecisionOutcome
} from '$lib/server/operator/ages';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	try {
		return {
			ageCase: await ageCase(db(), fieldCrypto(), subject, meta, event.params.id, new Date()),
			methods: AGE_CHECK_METHODS,
			documents: AGE_DOCUMENT_KINDS,
			decided: event.url.searchParams.get('decided'),
			hidden: event.url.searchParams.get('hidden') === '1'
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	decide: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		const method = AGE_CHECK_METHODS.find((value) => value === formText(form, 'method'));
		const documentKind = AGE_DOCUMENT_KINDS.find((value) => value === formText(form, 'documentKind'));
		let outcome: AgeDecisionOutcome;
		try {
			if (method === undefined || documentKind === undefined) {
				throw invalid([
					...(method === undefined ? [{ path: 'method', code: 'required', message: 'Выберите способ проверки' }] : []),
					...(documentKind === undefined
						? [{ path: 'documentKind', code: 'required', message: 'Выберите документ' }]
						: [])
				]);
			}
			outcome = await resolveAgeConflict(
				db(),
				subject,
				meta,
				event.params.id,
				{ birthDate: formText(form, 'birthDate'), method, documentKind },
				new Date()
			);
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?decided=${outcome.regime}${outcome.hidden ? '&hidden=1' : ''}`);
	}
};
