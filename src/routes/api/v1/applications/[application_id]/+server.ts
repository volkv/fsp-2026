import { serve } from '$lib/server/api/serve';
import { getCompanyApplication } from '$lib/server/api/v1/applications';

export const GET = serve(getCompanyApplication);
