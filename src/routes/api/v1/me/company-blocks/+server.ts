import { serve } from '$lib/server/api/serve';
import { listMyCompanyBlocks } from '$lib/server/api/v1/profile';

export const GET = serve(listMyCompanyBlocks);
