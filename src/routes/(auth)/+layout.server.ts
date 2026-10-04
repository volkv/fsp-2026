import type { LayoutServerLoad } from './$types';

/** Pages of sign-in and account are never cached: they carry the session token of their forms (`viewer` of the root). */
export const load: LayoutServerLoad = ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-store' });
};
