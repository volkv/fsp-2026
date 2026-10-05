import { serve } from '$lib/server/api/serve';
import { checkAttestationHolderOperation } from '$lib/server/api/v1/verify';

export const POST = serve(checkAttestationHolderOperation);
