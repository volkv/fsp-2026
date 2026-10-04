import { serve } from '$lib/server/api/serve';
import { listVacancyMatches } from '$lib/server/api/v1/catalog';

export const GET = serve(listVacancyMatches);
