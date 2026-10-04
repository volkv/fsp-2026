import { serve } from '$lib/server/api/serve';
import { annulAssessmentAttempt } from '$lib/server/api/v1/operator';

export const POST = serve(annulAssessmentAttempt);
