import { redirect } from '@sveltejs/kit';
import { adminRequest } from '$lib/server/admin/http';
import { bankReleasesOverview, bankTreeFamilies } from '$lib/server/assessments/bank-store';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { LEAK_DETECTOR } from '$lib/server/assessments/leak';
import { QUARANTINE_REASONS, leakPanel, liftQuarantine, quarantineFamily } from '$lib/server/assessments/quarantine';
import { invalid, requirePermission } from '$lib/server/companies/context';
import { db } from '$lib/server/db';
import { formText } from '$lib/server/http/form';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/**
 * Releases of the bank of test items (domain 10.5): what serves each specialization and the reports it passed, the
 * online signals of the solve rate of families and their quarantine.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await adminRequest(event);
	try {
		requirePermission(subject, 'policy.manage', null);
		return {
			releases: await bankReleasesOverview(db()),
			tree: await bankTreeFamilies(),
			leak: await leakPanel(db(), subject, new Date()),
			detector: LEAK_DETECTOR,
			reasons: QUARANTINE_REASONS,
			specializations: CATALOG.specializations.map((s) => ({
				key: s.key,
				title: s.title,
				availability: s.availability
			})),
			done: event.url.searchParams.get('done')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const familyOf = (form: FormData) => ({
	specialization: formText(form, 'specialization'),
	familyKey: formText(form, 'family')
});

export const actions: Actions = {
	quarantine: async (event) => {
		const { subject, meta } = await adminRequest(event);
		const form = await event.request.formData();
		const reason = QUARANTINE_REASONS.find((value) => value === formText(form, 'reason'));
		const note = formText(form, 'note').trim();
		try {
			if (reason === undefined) {
				throw invalid([{ path: 'reason', code: 'required', message: 'Выберите причину карантина' }]);
			}
			await quarantineFamily(
				db(),
				subject,
				meta,
				{ ...familyOf(form), reason, note: note === '' ? null : note },
				new Date()
			);
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?done=quarantined#leak`);
	},
	lift: async (event) => {
		const { subject, meta } = await adminRequest(event);
		const form = await event.request.formData();
		try {
			await liftQuarantine(db(), subject, meta, familyOf(form), new Date());
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?done=lifted#leak`);
	}
};
