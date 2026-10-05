import { serve } from '$lib/server/api/serve';
import { needRecommendedCategories } from '$lib/server/api/v1/needs';

export const GET = serve(needRecommendedCategories);
