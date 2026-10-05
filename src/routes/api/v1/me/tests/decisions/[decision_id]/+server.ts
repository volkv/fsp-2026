import { serve } from '$lib/server/api/serve';
import { getGradeDecision } from '$lib/server/api/v1/tests';

export const GET = serve(getGradeDecision);
