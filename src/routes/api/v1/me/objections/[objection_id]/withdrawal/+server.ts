import { serve } from '$lib/server/api/serve';
import { withdrawMyObjection } from '$lib/server/api/v1/categories';

export const POST = serve(withdrawMyObjection);
