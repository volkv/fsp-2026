import { serve } from '$lib/server/api/serve';
import { verifyCategoryAttestationOperation } from '$lib/server/api/v1/verify';

export const GET = serve(verifyCategoryAttestationOperation);
