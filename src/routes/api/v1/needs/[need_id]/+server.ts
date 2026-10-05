import { serve } from '$lib/server/api/serve';
import { getHiringNeed, updateHiringNeed } from '$lib/server/api/v1/needs';

export const GET = serve(getHiringNeed);
export const PATCH = serve(updateHiringNeed);
