import { serve } from '$lib/server/api/serve';
import { rotateEventSecret } from '$lib/server/api/v1/events';

export const POST = serve(rotateEventSecret);
