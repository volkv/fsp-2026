import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { judgementNote } from '$lib/server/assessments/explain';
import { gradeTitle } from '$lib/server/assessments/titles';
import { decisionView } from '$lib/server/assessments/views';
import { candidateRequest } from '$lib/server/candidates/http';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

/** The decision on a grade with its explanation by blocks (ч. 3 ст. 16 152-ФЗ) and what the policy offers next. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	const decisionId = z.uuid().safeParse(event.params.decisionId);
	if (!decisionId.success) error(404, { message: 'Решение не найдено', requestId: event.locals.requestId });
	try {
		const view = await decisionView(db(), subject, decisionId.data, new Date());
		return {
			decision: {
				...view,
				judgementNote: judgementNote(view.judgement),
				next: view.next.map((option) => ({
					grade: option.grade,
					title: gradeTitle(option.grade),
					available: option.available,
					reason: option.available ? null : option.reason,
					availableFrom: option.available ? null : (option.availableFrom ?? null)
				}))
			}
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
