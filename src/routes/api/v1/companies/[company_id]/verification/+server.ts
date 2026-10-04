import { serve } from '$lib/server/api/serve';
import { submitCompanyVerification } from '$lib/server/api/v1/companies';

export const POST = serve(submitCompanyVerification);
