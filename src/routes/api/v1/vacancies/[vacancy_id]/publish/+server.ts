import { serve } from '$lib/server/api/serve';
import { publishVacancy } from '$lib/server/api/v1/vacancies';

export const POST = serve(publishVacancy);
