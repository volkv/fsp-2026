import { serve } from '$lib/server/api/serve';
import { dismissMyChallenge } from '$lib/server/api/v1/challenges';

export const POST = serve(dismissMyChallenge);
