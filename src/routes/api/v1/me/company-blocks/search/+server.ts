import { serve } from '$lib/server/api/serve';
import { searchCompaniesToBlock } from '$lib/server/api/v1/profile';

export const GET = serve(searchCompaniesToBlock);
