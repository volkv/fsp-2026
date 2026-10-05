import { serve } from '$lib/server/api/serve';
import { submitChallengeSolution } from '$lib/server/api/v1/challenges';

export const POST = serve(submitChallengeSolution);
