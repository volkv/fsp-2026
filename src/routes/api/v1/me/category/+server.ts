import { serve } from '$lib/server/api/serve';
import { getMyCategory } from '$lib/server/api/v1/me';

export const GET = serve(getMyCategory);
