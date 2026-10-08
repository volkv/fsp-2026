import { serve } from '$lib/server/api/serve';
import { getMyConsents } from '$lib/server/api/v1/consents';

export const GET = serve(getMyConsents);
