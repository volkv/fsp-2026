import { serve } from '$lib/server/api/serve';
import { listTaxonomyWorkTerms } from '$lib/server/api/v1/taxonomy';

export const GET = serve(listTaxonomyWorkTerms);
