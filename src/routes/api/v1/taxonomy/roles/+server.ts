import { serve } from '$lib/server/api/serve';
import { listTaxonomyRoles } from '$lib/server/api/v1/taxonomy';

export const GET = serve(listTaxonomyRoles);
