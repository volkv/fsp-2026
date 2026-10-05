import { serve } from '$lib/server/api/serve';
import { listShortlistEvaluations, startShortlistEvaluation } from '$lib/server/api/v1/shortlists';

export const GET = serve(listShortlistEvaluations);
export const POST = serve(startShortlistEvaluation);
