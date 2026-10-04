import { error } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { lettersReaderOf, sessionLetter } from '$lib/server/demo/letters';
import { sessionOfBrowser } from '$lib/server/demo/visit';
import type { PageServerLoad } from './$types';

/** One letter of the visitor's demo session with its text and links; a letter the browser does not read is «not found». */
export const load: PageServerLoad = async (event) => {
	const { actor } = event.locals;
	const now = new Date();
	const browserSession = config().demo === null ? null : await sessionOfBrowser(db(), event.cookies, now);
	const reader = await lettersReaderOf(
		db(),
		actor.kind === 'session' ? actor.userId : null,
		browserSession?.id ?? null
	);
	if (reader === null) error(404, { message: 'Письмо не найдено', requestId: event.locals.requestId });
	const letter = await sessionLetter(
		db(),
		{ crypto: fieldCrypto(), appOrigin: config().appOrigin },
		reader,
		event.params.id
	);
	if (!letter) error(404, { message: 'Письмо не найдено', requestId: event.locals.requestId });
	event.setHeaders({ 'cache-control': 'private, no-store' });
	return { letter };
};
