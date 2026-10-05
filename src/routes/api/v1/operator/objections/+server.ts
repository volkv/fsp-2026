import { serve } from '$lib/server/api/serve';
import { listObjections } from '$lib/server/api/v1/categories';

export const GET = serve(listObjections);
