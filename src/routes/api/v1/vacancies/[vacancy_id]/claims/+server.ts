import { serve } from '$lib/server/api/serve';
import { claimVacancy } from '$lib/server/api/v1/vacancies';

export const POST = serve(claimVacancy);
