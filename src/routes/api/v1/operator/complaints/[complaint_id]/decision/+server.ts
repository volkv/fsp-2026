import { serve } from '$lib/server/api/serve';
import { decideOfferComplaint } from '$lib/server/api/v1/complaints';

export const POST = serve(decideOfferComplaint);
