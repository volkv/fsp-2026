import { serve } from '$lib/server/api/serve';
import { createCompanyApiKey, listCompanyApiKeys } from '$lib/server/api/v1/companies';

export const GET = serve(listCompanyApiKeys);
export const POST = serve(createCompanyApiKey);
