import { serve } from '$lib/server/api/serve';
import { openCategoryDispute } from '$lib/server/api/v1/me';

export const POST = serve(openCategoryDispute);
