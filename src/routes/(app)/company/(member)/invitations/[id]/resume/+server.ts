import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { employerRequest } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { openFile } from '$lib/server/storage/access';
import { objectStore } from '$lib/server/storage/object-store';
import type { RequestHandler } from './$types';

/**
 * The resume the candidate disclosed by an accepted invitation: the storage module checks that the reader is the
 * recipient and that the disclosure consent in effect lists the resume, and journals the attempt (`file.downloaded`).
 * A refusal is `404` whatever the reason.
 */
export const GET: RequestHandler = async (event) => {
	const { subject, meta } = await employerRequest(event);
	if (!z.uuid().safeParse(event.params.id).success)
		error(404, { message: 'Не найдено', requestId: event.locals.requestId });
	try {
		const file = await openFile(
			{ db: db(), store: objectStore(), now: () => new Date() },
			subject,
			event.url.searchParams.get('file') ?? '',
			{ kind: 'invitation', invitationId: event.params.id },
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
