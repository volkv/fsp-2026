import { serve } from '$lib/server/api/serve';
import { myConfirmationRequests } from '$lib/server/api/v1/confirmations';

export const GET = serve(myConfirmationRequests);
