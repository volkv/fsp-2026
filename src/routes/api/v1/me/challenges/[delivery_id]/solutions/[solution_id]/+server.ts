import { serve } from '$lib/server/api/serve';
import { withdrawChallengeSolution } from '$lib/server/api/v1/challenges';

export const DELETE = serve(withdrawChallengeSolution);
