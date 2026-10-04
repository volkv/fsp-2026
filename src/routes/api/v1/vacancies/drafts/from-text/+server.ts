import { serve } from '$lib/server/api/serve';
import { draftVacancyFromText } from '$lib/server/api/v1/vacancies';

export const POST = serve(draftVacancyFromText);
