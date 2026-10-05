import { serve } from '$lib/server/api/serve';
import { advanceDemoSessionClock } from '$lib/server/api/v1/challenges';

export const POST = serve(advanceDemoSessionClock);
