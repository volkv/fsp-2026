import { serve } from '$lib/server/api/serve';
import { listAttemptsForReview } from '$lib/server/api/v1/operator';

export const GET = serve(listAttemptsForReview);
