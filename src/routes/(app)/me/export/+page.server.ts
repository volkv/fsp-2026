import { candidateRequest } from '$lib/server/candidates/http';
import type { PageServerLoad } from './$types';

/** «Мои данные»: what the download holds; the file itself is `/me/export/download`. */
export const load: PageServerLoad = async (event) => {
	await candidateRequest(event);
	return {};
};
