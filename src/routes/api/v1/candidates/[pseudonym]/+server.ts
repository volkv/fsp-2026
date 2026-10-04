import { serve } from '$lib/server/api/serve';
import { getCandidateCard } from '$lib/server/api/v1/catalog';

export const GET = serve(getCandidateCard);
