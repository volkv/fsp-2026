import { serve } from '$lib/server/api/serve';
import { revokeCompanyApiKey } from '$lib/server/api/v1/companies';

export const DELETE = serve(revokeCompanyApiKey);
