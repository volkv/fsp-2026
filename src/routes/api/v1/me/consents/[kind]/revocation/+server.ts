import { serve } from '$lib/server/api/serve';
import { revokeMyConsent } from '$lib/server/api/v1/consents';

export const POST = serve(revokeMyConsent);
