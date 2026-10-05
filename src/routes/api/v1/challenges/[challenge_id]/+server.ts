import { serve } from '$lib/server/api/serve';
import { getCompanyChallenge, updateCompanyChallenge } from '$lib/server/api/v1/challenges';

export const GET = serve(getCompanyChallenge);
export const PATCH = serve(updateCompanyChallenge);
