import { serve } from '$lib/server/api/serve';
import { declineConfirmationRequest } from '$lib/server/api/v1/confirmations';

export const POST = serve(declineConfirmationRequest);
