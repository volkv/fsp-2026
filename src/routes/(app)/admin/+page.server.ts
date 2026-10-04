import { requireStandChange, standChangesLocked } from '$lib/server/access/demo-actor';
import { adminRequest, integrationsDeps, modelsDeps } from '$lib/server/admin/http';
import { db } from '$lib/server/db';
import { integrationsState } from '$lib/server/admin/integrations';
import { modelsOverview, parseModeSwitch, switchModelMode } from '$lib/server/admin/models';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	try {
		const [models, integrations, demoLocked] = await Promise.all([
			modelsOverview(modelsDeps(), ctx),
			integrationsState(integrationsDeps(), ctx),
			standChangesLocked(db(), ctx.subject)
		]);
		return { models, integrations, demoLocked };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	switchMode: async (event) => {
		const ctx = await adminRequest(event);
		try {
			// The modes are shared by every visitor of the stand: a demo account only looks at them.
			await requireStandChange(db(), ctx.subject);
			const change = parseModeSwitch(await event.request.formData());
			const { changed } = await switchModelMode(modelsDeps(), ctx, change);
			return { done: { operation: change.operation, mode: change.mode, changed } };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
