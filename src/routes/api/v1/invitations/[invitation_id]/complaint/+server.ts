import { serve } from '$lib/server/api/serve';
import { fileOfferComplaint, getOfferComplaint } from '$lib/server/api/v1/complaints';

export const GET = serve(getOfferComplaint);
export const POST = serve(fileOfferComplaint);
