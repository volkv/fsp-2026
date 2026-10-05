import { serve } from '$lib/server/api/serve';
import { createEventWebhook, listEventSubscriptions } from '$lib/server/api/v1/events';

export const GET = serve(listEventSubscriptions);
export const POST = serve(createEventWebhook);
