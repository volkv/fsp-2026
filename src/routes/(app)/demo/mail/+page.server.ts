import { error } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { lettersReaderOf, sessionLetters } from '$lib/server/demo/letters';
import { sessionOfBrowser } from '$lib/server/demo/visit';
import type { PageServerLoad } from './$types';

/**
 * Letters of the visitor's demo session: those to the representative of the session's teenager with their one-time
 * links, the confirmations of the address and the password resets of the accounts registered within the session, and
 * the notifications of its accounts as the letters they would be. A signed-in account of the session reads them all; a
 * browser that holds the session and is signed in to nothing of it reads the letters to the registered accounts only.
 * For anybody else the page does not exist.
 */
export const load: PageServerLoad = async (event) => {
	const { actor } = event.locals;
	const now = new Date();
	const browserSession = config().demo === null ? null : await sessionOfBrowser(db(), event.cookies, now);
	const reader = await lettersReaderOf(
		db(),
		actor.kind === 'session' ? actor.userId : null,
		browserSession?.id ?? null
	);
	if (reader === null) error(404, { message: 'Не найдено', requestId: event.locals.requestId });
	event.setHeaders({ 'cache-control': 'private, no-store' });
	return {
		scope: reader.scope,
		letters: await sessionLetters(db(), { crypto: fieldCrypto(), appOrigin: config().appOrigin }, reader)
	};
};
