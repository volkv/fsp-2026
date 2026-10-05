import { serve } from '$lib/server/api/serve';
import { addMyExperience } from '$lib/server/api/v1/profile';

export const POST = serve(addMyExperience);
