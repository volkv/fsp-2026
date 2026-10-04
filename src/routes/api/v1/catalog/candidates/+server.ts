import { serve } from '$lib/server/api/serve';
import { searchCatalog } from '$lib/server/api/v1/catalog';

export const GET = serve(searchCatalog);
