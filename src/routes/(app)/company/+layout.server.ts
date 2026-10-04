import type { LayoutServerLoad } from './$types';

/** Pages of the employer cabinet are never cached: they carry the session token of their forms and company data. */
export const load: LayoutServerLoad = ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-store' });
};
