import { formText } from '$lib/server/auth/http';
import { requireStandChange, standChangesLocked } from '$lib/server/access/demo-actor';
import { adminRequest } from '$lib/server/admin/http';
import { reviewUnknownSkill, unknownSkillFilterOf, unknownSkillQueue } from '$lib/server/admin/reference';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/**
 * The queue of skills the taxonomy does not know, collected from the tags of external postings: the most frequent
 * first, filtered by the review mark (`?status=`) and by the spelling (`?q=`).
 */
export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	try {
		const database = db();
		const filter = unknownSkillFilterOf(event.url.searchParams.get('status'));
		const [queue, demoLocked] = await Promise.all([
			unknownSkillQueue(database, ctx, { filter, query: event.url.searchParams.get('q') ?? '' }),
			standChangesLocked(database, ctx.subject)
		]);
		return { queue, demoLocked };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	review: async (event) => {
		const ctx = await adminRequest(event);
		try {
			// The queue is shared by every visitor of the stand: a demo account only looks at it.
			await requireStandChange(db(), ctx.subject);
			const form = await event.request.formData();
			const done = await reviewUnknownSkill(db(), ctx, {
				spelling: formText(form, 'spelling'),
				status: formText(form, 'status')
			});
			return { done };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
