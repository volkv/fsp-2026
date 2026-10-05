import { serve } from '$lib/server/api/serve';
import { getCompanyProfile, patchCompanyProfile } from '$lib/server/api/v1/company-profile';

export const GET = serve(getCompanyProfile);
export const PATCH = serve(patchCompanyProfile);
