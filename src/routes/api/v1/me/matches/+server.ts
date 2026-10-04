import { serve } from '$lib/server/api/serve';
import { listMyMatches } from '$lib/server/api/v1/me';

export const GET = serve(listMyMatches);
