import { serve } from '$lib/server/api/serve';
import { createConfirmationRequest, listConfirmationRequests } from '$lib/server/api/v1/confirmations';

export const GET = serve(listConfirmationRequests);
export const POST = serve(createConfirmationRequest);
