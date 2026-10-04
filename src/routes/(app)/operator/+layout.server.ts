import { operatorRequest } from '$lib/server/operator/http';
import type { LayoutServerLoad } from './$types';

/**
 * Every page of the cabinet: the operator role is read on this request (a revoked role closes the cabinet at once), and
 * the pages are never cached — they carry the session token of their forms and personal data of cases.
 */
export const load: LayoutServerLoad = async (event) => {
	event.setHeaders({ 'cache-control': 'private, no-store' });
	await operatorRequest(event);
	return {};
};
