import { serve } from '$lib/server/api/serve';
import { withdrawClaim } from '$lib/server/api/v1/vacancies';

export const POST = serve(withdrawClaim);
