import { serve } from '$lib/server/api/serve';
import { createHiringNeed, listHiringNeeds } from '$lib/server/api/v1/needs';

export const GET = serve(listHiringNeeds);
export const POST = serve(createHiringNeed);
