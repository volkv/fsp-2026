import { serve } from '$lib/server/api/serve';
import { listTaxonomyGrades } from '$lib/server/api/v1/taxonomy';

export const GET = serve(listTaxonomyGrades);
