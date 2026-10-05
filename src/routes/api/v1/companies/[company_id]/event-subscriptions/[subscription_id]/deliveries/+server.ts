import { serve } from '$lib/server/api/serve';
import { listEventDeliveries } from '$lib/server/api/v1/events';

export const GET = serve(listEventDeliveries);
