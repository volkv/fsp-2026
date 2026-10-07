import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { can } from '$lib/server/access/permissions';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { startAttempt } from '$lib/server/assessments/engine';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { specializationTitle, gradeTitle } from '$lib/server/assessments/titles';
import { testsOverview } from '$lib/server/assessments/views';
import { candidateRequest, type CandidateRequest } from '$lib/server/candidates/http';
import { db } from '$lib/server/db';
import { demoPolicyNote } from '$lib/server/demo/grade-policy';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/** The tests the grade policy lets the candidate take now, why the others are closed, and the attempts so far. */
export const load: PageServerLoad = async (event) => {
	const { subject, candidateId } = await candidateRequest(event);
	try {
		const [overview, demoNote] = await Promise.all([
			testsOverview(db(), subject, new Date()),
			demoPolicyNote(db(), candidateId)
		]);
		return {
			demoNote,
			specializations: overview.specializations.map((s) => ({
				key: s.key,
				title: specializationTitle(s.key),
				options: s.options.map((o) => ({
					grade: o.grade,
					title: gradeTitle(o.grade),
					available: o.available,
					kind: o.available ? o.kind : null,
					reason: o.available ? null : o.reason,
					availableFrom: o.available ? null : (o.availableFrom ?? null)
				}))
			})),
			activeAttemptId: overview.activeAttemptId,
			attempts: overview.attempts
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

async function writer(event: RequestEvent): Promise<CandidateRequest> {
	const request = await candidateRequest(event);
	const access = can(request.subject, 'candidate.self.write', { candidateId: request.candidateId });
	if (!access.allowed) error(403, { message: 'Недостаточно прав', requestId: event.locals.requestId });
	return request;
}

const startForm = z.object({ specialization: z.enum(SPECIALIZATION_KEYS), grade: z.enum(GRADE_KEYS) });

export const actions: Actions = {
	start: async (event) => {
		const { subject, meta } = await writer(event);
		const form = Object.fromEntries(await event.request.formData());
		const parsed = startForm.safeParse(form);
		if (!parsed.success) error(400, { message: 'Выберите специализацию и грейд', requestId: meta.requestId });
		let attemptId: string;
		try {
			const { attempt } = await startAttempt(db(), { standing: OWNER_STANDING }, subject, parsed.data, {
				now: new Date(),
				requestId: meta.requestId
			});
			attemptId = attempt.id;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/me/tests/attempts/${attemptId}`);
	}
};
