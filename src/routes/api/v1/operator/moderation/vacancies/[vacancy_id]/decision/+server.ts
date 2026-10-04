import { serve } from '$lib/server/api/serve';
import { decideVacancyModeration } from '$lib/server/api/v1/operator';

export const POST = serve(decideVacancyModeration);
