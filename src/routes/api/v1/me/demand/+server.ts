import { serve } from '$lib/server/api/serve';
import { getMyNeedDemand } from '$lib/server/api/v1/demand';

export const GET = serve(getMyNeedDemand);
