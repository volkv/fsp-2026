import { serve } from '$lib/server/api/serve';
import { listBankReleases } from '$lib/server/api/v1/tests';

export const GET = serve(listBankReleases);
