import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { adminRequest } from '$lib/server/admin/http';
import { qualityPanel } from '$lib/server/admin/quality';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	const notFound = () => error(404, { message: 'Запуск оценки не найден', requestId: event.locals.requestId });
	if (!z.uuid().safeParse(event.params.id).success) notFound();
	let panel;
	try {
		panel = await qualityPanel(db(), ctx, event.params.id);
	} catch (cause) {
		pageError(event, cause);
	}
	if (panel.run === null) notFound();
	return { panel };
};
