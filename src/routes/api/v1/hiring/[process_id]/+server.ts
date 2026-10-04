import { serve } from '$lib/server/api/serve';
import { getProcess } from '$lib/server/api/v1/hiring';

export const GET = serve(getProcess);
