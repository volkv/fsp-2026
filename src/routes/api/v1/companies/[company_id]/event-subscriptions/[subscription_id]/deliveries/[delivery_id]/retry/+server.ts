import { serve } from '$lib/server/api/serve';
import { redeliverEvent } from '$lib/server/api/v1/events';

export const POST = serve(redeliverEvent);
