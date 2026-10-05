import { serve } from '$lib/server/api/serve';
import { judgeShortlistEvaluation } from '$lib/server/api/v1/shortlists';

export const POST = serve(judgeShortlistEvaluation);
