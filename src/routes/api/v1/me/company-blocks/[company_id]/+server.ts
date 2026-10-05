import { serve } from '$lib/server/api/serve';
import { blockMyCompany, unblockMyCompany } from '$lib/server/api/v1/profile';

export const PUT = serve(blockMyCompany);
export const DELETE = serve(unblockMyCompany);
