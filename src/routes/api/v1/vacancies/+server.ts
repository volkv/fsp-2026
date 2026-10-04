import { serve } from '$lib/server/api/serve';
import { createVacancy, searchVacancies } from '$lib/server/api/v1/vacancies';

export const GET = serve(searchVacancies);
export const POST = serve(createVacancy);
