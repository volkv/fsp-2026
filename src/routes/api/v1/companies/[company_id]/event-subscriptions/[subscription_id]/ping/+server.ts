import { serve } from '$lib/server/api/serve';
import { pingEventSubscription } from '$lib/server/api/v1/events';

export const POST = serve(pingEventSubscription);
