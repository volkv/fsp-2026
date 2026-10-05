import { serve } from '$lib/server/api/serve';
import { markShortlistCandidate, unmarkShortlistCandidate } from '$lib/server/api/v1/shortlists';

export const PUT = serve(markShortlistCandidate);
export const DELETE = serve(unmarkShortlistCandidate);
