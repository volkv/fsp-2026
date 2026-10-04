import { serve } from '$lib/server/api/serve';
import { getCompany, updateCompany } from '$lib/server/api/v1/companies';

export const GET = serve(getCompany);
export const PATCH = serve(updateCompany);
