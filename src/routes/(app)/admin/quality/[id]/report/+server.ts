import { objectStore } from '$lib/server/storage/object-store';
import { openFile } from '$lib/server/storage/access';
import { adminRequest } from '$lib/server/admin/http';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

/**
 * The report file of an evaluation run: the storage module checks the administrator role and that the file is the
 * run's report, and journals the download. A refusal is `404` whatever the reason.
 */
export const GET: RequestHandler = async (event) => {
	const { subject, meta } = await adminRequest(event);
	const fileId = event.url.searchParams.get('file') ?? '';
	if (!z.uuid().safeParse(event.params.id).success)
		error(404, { message: 'Не найдено', requestId: event.locals.requestId });
	try {
		const file = await openFile(
			{ db: db(), store: objectStore(), now: () => new Date() },
			subject,
			fileId,
			{ kind: 'eval_report', runId: event.params.id },
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
