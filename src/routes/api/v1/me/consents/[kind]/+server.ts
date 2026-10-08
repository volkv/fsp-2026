import { serve } from '$lib/server/api/serve';
import { grantMyConsent } from '$lib/server/api/v1/consents';

export const POST = serve(grantMyConsent);
