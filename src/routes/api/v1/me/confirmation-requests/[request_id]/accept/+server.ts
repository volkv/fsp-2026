import { serve } from '$lib/server/api/serve';
import { acceptConfirmationRequest } from '$lib/server/api/v1/confirmations';

export const POST = serve(acceptConfirmationRequest);
