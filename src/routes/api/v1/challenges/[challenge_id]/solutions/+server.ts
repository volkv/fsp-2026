import { serve } from '$lib/server/api/serve';
import { listChallengeSolutions } from '$lib/server/api/v1/challenges';

export const GET = serve(listChallengeSolutions);
