import { serve } from '$lib/server/api/serve';
import { dismissChallengeSolution } from '$lib/server/api/v1/challenges';

export const POST = serve(dismissChallengeSolution);
