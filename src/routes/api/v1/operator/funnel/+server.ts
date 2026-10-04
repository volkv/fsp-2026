import { serve } from '$lib/server/api/serve';
import { getFunnel } from '$lib/server/api/v1/operator';

export const GET = serve(getFunnel);
