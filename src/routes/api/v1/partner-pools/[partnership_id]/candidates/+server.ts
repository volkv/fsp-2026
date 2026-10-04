import { serve } from '$lib/server/api/serve';
import { listPartnerPoolCandidates } from '$lib/server/api/v1/partner-pools';

export const GET = serve(listPartnerPoolCandidates);
