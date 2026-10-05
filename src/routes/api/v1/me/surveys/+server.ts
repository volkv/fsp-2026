import { serve } from '$lib/server/api/serve';
import { submitMySurvey } from '$lib/server/api/v1/grades';

export const POST = serve(submitMySurvey);
