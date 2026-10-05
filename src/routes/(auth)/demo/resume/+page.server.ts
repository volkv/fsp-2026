import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { requestMeta } from '$lib/server/auth/http';
import { currentDocument } from '$lib/server/auth/documents';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { DEMO_IDLE_MINUTES, lastEndOf } from '$lib/server/demo/activity';
import { uploadOwnResume } from '$lib/server/demo/own-resume';
import { demoTerms, sessionOfAccount } from '$lib/server/demo/visit';
import { assertResumeSize } from '$lib/server/documents/limits';
import { formFailure } from '$lib/server/http/page';
import { resumeDeps } from '$lib/server/resumes/deps';
import type { Actions, PageServerLoad } from './$types';

/** The signed-in clone and its live demo session; `null` — the visitor is not a candidate of a demo session. */
async function demoCandidate(event: RequestEvent) {
	if (config().demo === null) error(404, { message: 'Не найдено', requestId: event.locals.requestId });
	const { actor } = event.locals;
	if (actor.kind !== 'session') return null;
	const session = await sessionOfAccount(db(), actor.userId, new Date());
	if (!session) return null;
	const subject = await loadAccessSubject(db(), actor);
	if (subject.candidate?.status !== 'active') return null;
	return { actor, subject, session };
}

export const load: PageServerLoad = async (event) => {
	const current = await demoCandidate(event);
	const document = await currentDocument(db(), 'demo_resume_upload', new Date());
	if (!document?.available) throw new Error('the consent demo_resume_upload is not published');
	const terms = await demoTerms(db());
	const now = new Date();
	// An upload now shortens the session to the term of the resume; the nightly reset may come first.
	const endsAt =
		current === null
			? null
			: lastEndOf(
					new Date(Math.min(current.session.expiresAt.getTime(), now.getTime() + terms.ownResumeHours * 3_600_000)),
					now
				);
	return {
		candidate: current !== null,
		endsAt,
		nightlyReset: config().demo?.nightlyReset === true,
		ownResumeHours: terms.ownResumeHours,
		idleHours: DEMO_IDLE_MINUTES / 60,
		document: { id: document.id, title: document.title, body: document.body, version: document.version }
	};
};

export const actions: Actions = {
	default: async (event) => {
		const current = await demoCandidate(event);
		if (!current) redirect(303, '/demo');
		const form = await event.request.formData();
		if (form.get('agree') !== 'on') {
			return fail(400, {
				problem: { message: 'Отметьте согласие, чтобы загрузить резюме', fields: {}, code: 'consent' }
			});
		}
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { problem: { message: 'Выберите файл резюме', fields: {}, code: 'empty' } });
		}
		const documentId = form.get('document');
		try {
			assertResumeSize(file.size);
			await uploadOwnResume(
				resumeDeps(),
				current.subject,
				{ ...requestMeta(event), sessionHash: current.actor.sessionHash },
				{
					sessionId: current.session.id,
					documentId: typeof documentId === 'string' ? documentId : '',
					bytes: new Uint8Array(await file.arrayBuffer()),
					declaredName: file.name
				},
				await demoTerms(db())
			);
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, '/me/resume');
	}
};
