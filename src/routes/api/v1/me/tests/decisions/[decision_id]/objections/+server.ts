import { serve } from '$lib/server/api/serve';
import { openTestObjection } from '$lib/server/api/v1/categories';

export const POST = serve(openTestObjection);
