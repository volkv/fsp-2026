import { serve } from '$lib/server/api/serve';
import { listCompanyVacancies } from '$lib/server/api/v1/vacancies';

export const GET = serve(listCompanyVacancies);
