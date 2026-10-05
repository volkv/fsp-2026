import { serve } from '$lib/server/api/serve';
import { createNeedShortlist, listNeedShortlists } from '$lib/server/api/v1/shortlists';

export const GET = serve(listNeedShortlists);
export const POST = serve(createNeedShortlist);
