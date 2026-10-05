import { serve } from '$lib/server/api/serve';
import { getTest } from '$lib/server/api/v1/tests';

export const GET = serve(getTest);
