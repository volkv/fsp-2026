import { serve } from '$lib/server/api/serve';
import { getVacancy, updateVacancy } from '$lib/server/api/v1/vacancies';

export const GET = serve(getVacancy);
export const PATCH = serve(updateVacancy);
