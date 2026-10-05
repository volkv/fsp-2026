// Glue between the pages of the survey and the declaration and SvelteKit requests: they open to a signed-in candidate
// whose profile is open (the processing consent given); anyone else goes back to the registration steps.
import { redirect, type RequestEvent } from '@sveltejs/kit';
import type { AccessSubject } from '$lib/server/access/permissions';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { db } from '$lib/server/db';
import type { GradeRequestMeta } from './self';

export async function gradeCandidate(
	event: RequestEvent
): Promise<{ subject: AccessSubject; candidateId: string; meta: GradeRequestMeta }> {
	requireSession(event);
	const { actor } = event.locals;
	if (actor.kind !== 'session') throw new Error('a required session is not a session actor');
	const subject = await loadAccessSubject(db(), actor);
	if (subject.candidate?.status !== 'active') redirect(303, '/onboarding');
	return { subject, candidateId: subject.candidate.id, meta: requestMeta(event) };
}
