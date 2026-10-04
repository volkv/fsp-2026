import { serve } from '$lib/server/api/serve';
import { removeCompanyMember, updateCompanyMember } from '$lib/server/api/v1/companies';

export const PATCH = serve(updateCompanyMember);
export const DELETE = serve(removeCompanyMember);
