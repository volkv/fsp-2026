import { serve } from '$lib/server/api/serve';
import { listMyCategories } from '$lib/server/api/v1/categories';

export const GET = serve(listMyCategories);
