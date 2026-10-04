import { serve } from '$lib/server/api/serve';
import { pauseVacancy } from '$lib/server/api/v1/vacancies';

export const POST = serve(pauseVacancy);
