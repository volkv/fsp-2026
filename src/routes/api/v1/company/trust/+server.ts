import { serve } from '$lib/server/api/serve';
import { getCompanyTrust } from '$lib/server/api/v1/company-profile';

export const GET = serve(getCompanyTrust);
