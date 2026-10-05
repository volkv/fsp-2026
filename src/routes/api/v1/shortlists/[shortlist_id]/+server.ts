import { serve } from '$lib/server/api/serve';
import { getShortlist } from '$lib/server/api/v1/shortlists';

export const GET = serve(getShortlist);
