import { serve } from '$lib/server/api/serve';
import { listTaxonomySkills } from '$lib/server/api/v1/taxonomy';

export const GET = serve(listTaxonomySkills);
