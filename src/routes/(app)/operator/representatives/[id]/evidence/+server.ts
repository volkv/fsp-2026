import { objectStore } from '$lib/server/storage/object-store';
import { openFile } from '$lib/server/storage/access';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

/**
 * The copy of a representative's authority document kept with a check: the storage module decides the case access and
 * journals it (`operator.case_access` with `file.downloaded`). A refusal is `404` whatever the reason.
 */
export const GET: RequestHandler = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const fileId = event.url.searchParams.get('file') ?? '';
	if (!z.uuid().safeParse(event.params.id).success)
		error(404, { message: 'Не найдено', requestId: event.locals.requestId });
	try {
		const file = await openFile(
			{ db: db(), store: objectStore(), now: () => new Date() },
			subject,
			fileId,
			{ kind: 'case', caseType: 'authority', caseId: event.params.id },
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
