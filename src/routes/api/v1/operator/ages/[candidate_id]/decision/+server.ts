import { serve } from '$lib/server/api/serve';
import { decideAgeConflict } from '$lib/server/api/v1/operator';

export const POST = serve(decideAgeConflict);
