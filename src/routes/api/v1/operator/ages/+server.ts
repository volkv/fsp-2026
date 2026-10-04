import { serve } from '$lib/server/api/serve';
import { listAgeConflicts } from '$lib/server/api/v1/operator';

export const GET = serve(listAgeConflicts);
