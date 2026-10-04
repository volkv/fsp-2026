import { standChangesLocked } from '$lib/server/access/demo-actor';
import { adminRequest, sourcesDeps } from '$lib/server/admin/http';
import { parseSourceSwitch, switchVacancySource, vacancySourcesState } from '$lib/server/admin/sources';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	try {
		const [sources, demoLocked] = await Promise.all([
			vacancySourcesState(sourcesDeps(), ctx),
			standChangesLocked(db(), ctx.subject)
		]);
		return { sources, demoLocked };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	switchSource: async (event) => {
		const ctx = await adminRequest(event);
		try {
			const change = parseSourceSwitch(await event.request.formData());
			const result = await switchVacancySource(sourcesDeps(), ctx, change);
			return { done: { name: result.name, enabled: change.enabled, changed: result.changed } };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
