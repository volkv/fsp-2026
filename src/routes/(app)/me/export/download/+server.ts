import { candidateRequest } from '$lib/server/candidates/http';
import { exportOwnData } from '$lib/server/candidates/data-export';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * The candidate's data as a JSON file (domain 18.2, `data.exported`). Read only by its own session: a page of another
 * site can make the browser send the request but cannot read the answer.
 */
export const GET: RequestHandler = async (event) => {
	const { userId, candidateId, meta } = await candidateRequest(event);
	const document = await exportOwnData(db(), fieldCrypto(), {
		userId,
		candidateId,
		actor: { kind: 'user', userId },
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		channel: 'ui'
	});
	return new Response(JSON.stringify(document, null, 2), {
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'content-disposition': `attachment; filename="fsp-career-data-${document.exported_at.slice(0, 10)}.json"`,
			'cache-control': 'private, no-store'
		}
	});
};
