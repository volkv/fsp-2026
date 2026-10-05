import { serve } from '$lib/server/api/serve';
import { rejectCompanyApplication } from '$lib/server/api/v1/applications';

export const POST = serve(rejectCompanyApplication);
