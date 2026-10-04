import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The cabinet starts with the profile. */
export const load: PageServerLoad = () => {
	redirect(307, '/me/profile');
};
