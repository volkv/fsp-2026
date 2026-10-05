import { serve } from '$lib/server/api/serve';
import { listMyChallenges } from '$lib/server/api/v1/challenges';

export const GET = serve(listMyChallenges);
