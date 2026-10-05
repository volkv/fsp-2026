import { serve } from '$lib/server/api/serve';
import { connectEventHuntflow } from '$lib/server/api/v1/events';

export const POST = serve(connectEventHuntflow);
