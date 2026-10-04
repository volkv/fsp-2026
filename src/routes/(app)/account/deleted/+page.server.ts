import type { PageServerLoad } from './$types';

/** After the deletion: the session is gone, the page only confirms it and says whether the letter left. */
export const load: PageServerLoad = ({ url }) => ({ letterSent: url.searchParams.get('letter') === 'sent' });
