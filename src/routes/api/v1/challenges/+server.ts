import { serve } from '$lib/server/api/serve';
import { createCompanyChallenge, listCompanyChallenges } from '$lib/server/api/v1/challenges';

export const GET = serve(listCompanyChallenges);
export const POST = serve(createCompanyChallenge);
