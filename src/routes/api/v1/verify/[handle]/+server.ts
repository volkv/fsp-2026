import { serve } from '$lib/server/api/serve';
import { verifyReceiptOperation } from '$lib/server/api/v1/verify';

export const GET = serve(verifyReceiptOperation);
