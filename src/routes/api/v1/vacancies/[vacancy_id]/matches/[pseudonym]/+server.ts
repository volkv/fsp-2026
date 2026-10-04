import { serve } from '$lib/server/api/serve';
import { getVacancyMatch } from '$lib/server/api/v1/catalog';

export const GET = serve(getVacancyMatch);
