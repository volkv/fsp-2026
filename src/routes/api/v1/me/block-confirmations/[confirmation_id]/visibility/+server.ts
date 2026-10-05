import { serve } from '$lib/server/api/serve';
import { setBlockConfirmationVisibility } from '$lib/server/api/v1/confirmations';

export const PUT = serve(setBlockConfirmationVisibility);
