import { serve } from '$lib/server/api/serve';
import { deleteEventSubscription, updateEventSubscription } from '$lib/server/api/v1/events';

export const PATCH = serve(updateEventSubscription);
export const DELETE = serve(deleteEventSubscription);
