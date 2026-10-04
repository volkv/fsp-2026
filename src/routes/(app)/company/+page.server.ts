import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The cabinet starts with the vacancies: a search and invitations are made for one of them. */
export const load: PageServerLoad = () => {
	redirect(307, '/company/vacancies');
};
