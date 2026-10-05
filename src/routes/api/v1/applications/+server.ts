import { serve } from '$lib/server/api/serve';
import { listCompanyApplications } from '$lib/server/api/v1/applications';

export const GET = serve(listCompanyApplications);
