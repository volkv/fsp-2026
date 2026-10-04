import { serve } from '$lib/server/api/serve';
import { compareCatalogCandidates } from '$lib/server/api/v1/catalog';

export const GET = serve(compareCatalogCandidates);
