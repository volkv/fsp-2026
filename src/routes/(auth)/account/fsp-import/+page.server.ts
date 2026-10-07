import { fail, redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { confirmFspAchievements } from '$lib/server/auth/identities';
import { config } from '$lib/server/config';
import type { Actions, PageServerLoad } from './$types';

/** «Подтвердить достижения из ФСП»: the `fsp_import` consent on its own screen (contracts 2.4, step 5). */
export const load: PageServerLoad = async (event) => {
	requireSession(event);
	const deps = await authDeps();
	const document = await currentDocument(deps.db, 'fsp_import', deps.now());
	if (!config().fspId || document?.available !== true) redirect(303, '/account');
	return { document: { id: document.id, title: document.title, version: document.version, body: document.body } };
};

export const actions: Actions = {
	default: async (event) => {
		const session = requireSession(event);
		const issuer = config().fspId?.issuer;
		if (!issuer) redirect(303, '/account');
		const form = await event.request.formData();
		const result = await confirmFspAchievements(await authDeps(), requestMeta(event), session, {
			issuer,
			documentId: formText(form, 'documentId')
		});
		if (!result.ok) {
			const message = {
				not_candidate: 'Импорт достижений доступен кандидату после согласия на обработку профиля',
				no_identity: 'Сначала привяжите ФСП ID',
				document_changed: 'Текст согласия обновился — прочитайте новую редакцию',
				athlete_taken: 'Этот спортсмен уже связан с другой учётной записью'
			}[result.reason];
			return fail(409, { message });
		}
		redirect(303, '/account?fsp=imported');
	}
};
