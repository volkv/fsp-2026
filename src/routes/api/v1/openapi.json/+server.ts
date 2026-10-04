import { serve } from '$lib/server/api/serve';
import { getOpenApiDocument } from '$lib/server/api/v1';

export const GET = serve(getOpenApiDocument);
