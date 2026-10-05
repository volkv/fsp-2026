import { serve } from '$lib/server/api/serve';
import { withdrawMyApplication } from '$lib/server/api/v1/applications';

export const POST = serve(withdrawMyApplication);
