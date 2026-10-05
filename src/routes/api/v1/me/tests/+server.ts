import { serve } from '$lib/server/api/serve';
import { startTest } from '$lib/server/api/v1/tests';

export const POST = serve(startTest);
