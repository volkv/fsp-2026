import { serve } from '$lib/server/api/serve';
import { markChallengeViewed } from '$lib/server/api/v1/challenges';

export const POST = serve(markChallengeViewed);
