import { requireSession } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { listNotifications, markAllRead } from '$lib/server/notifications/inbox';
import type { Actions, PageServerLoad } from './$types';

/** Notifications of the signed-in person, newest first; every channel leads here by the link of one of them. */
export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	event.setHeaders({ 'cache-control': 'private, no-store' });
	const cursor = event.url.searchParams.get('cursor');
	return { inbox: await listNotifications(db(), session.userId, cursor), cursor };
};

export const actions: Actions = {
	readAll: async (event) => {
		const session = requireSession(event);
		await markAllRead(db(), session.userId, new Date());
		return { allRead: true };
	}
};
