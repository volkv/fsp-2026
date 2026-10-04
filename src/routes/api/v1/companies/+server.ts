import { serve } from '$lib/server/api/serve';
import { createCompany } from '$lib/server/api/v1/companies';

export const POST = serve(createCompany);
