import { serve } from '$lib/server/api/serve';
import { closeVacancy } from '$lib/server/api/v1/vacancies';

export const POST = serve(closeVacancy);
