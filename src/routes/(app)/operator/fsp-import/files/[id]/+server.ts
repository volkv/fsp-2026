import { requestMeta, requireSession } from '$lib/server/auth/http';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { openFile } from '$lib/server/storage/access';
import { objectStore } from '$lib/server/storage/object-store';
import type { RequestHandler } from './$types';

/**
 * The source file of an imported batch of FSP results: the storage module checks `fsp.import` and journals the
 * download (`file.downloaded`). A refusal is `404` whatever the reason — to anyone signed in, not only to the staff,
 * so the address does not tell whether the file exists.
 */
export const GET: RequestHandler = async (event) => {
	requireSession(event);
	const { actor } = event.locals;
	if (actor.kind !== 'session') throw new Error('a required session is not a session actor');
	const subject = await loadAccessSubject(db(), actor);
	const meta = requestMeta(event);
	try {
		const file = await openFile(
			{ db: db(), store: objectStore(), now: () => new Date() },
			subject,
			event.params.id,
			{ kind: 'source_batch' },
			meta
		);
		return new Response(file.body, {
			headers: {
				'content-type': file.contentType,
				'content-length': String(file.sizeBytes),
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.declaredName)}`,
				'cache-control': 'private, no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (cause) {
		pageError(event, cause);
	}
};
