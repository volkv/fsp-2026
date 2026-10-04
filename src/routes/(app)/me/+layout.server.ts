import type { LayoutServerLoad } from './$types';

/** Pages of the candidate cabinet are never cached: they carry personal data and the session token of their forms. */
export const load: LayoutServerLoad = ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-store' });
};
