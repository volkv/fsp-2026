import { serve } from '$lib/server/api/serve';
import { getCategoryCatalog } from '$lib/server/api/v1/grades';

export const GET = serve(getCategoryCatalog);
