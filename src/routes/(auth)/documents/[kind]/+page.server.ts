import { error } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { DOCUMENT_KINDS, type DocumentKind } from '$lib/server/consent/kinds';
import type { PageServerLoad } from './$types';

function isDocumentKind(value: string): value is DocumentKind {
	return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** The current published text of a legal document, as the sign-up forms link to it. */
export const load: PageServerLoad = async ({ params, locals }) => {
	if (!isDocumentKind(params.kind)) error(404, { message: 'Документ не найден', requestId: locals.requestId });
	const deps = await authDeps();
	const document = await currentDocument(deps.db, params.kind, deps.now());
	if (!document) error(404, { message: 'Документ ещё не опубликован', requestId: locals.requestId });
	return { document: { title: document.title, version: document.version, body: document.body } };
};
