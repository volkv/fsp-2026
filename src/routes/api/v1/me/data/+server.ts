import { serve } from '$lib/server/api/serve';
import { getMyData } from '$lib/server/api/v1/me';

export const GET = serve(getMyData);
