import { serve } from '$lib/server/api/serve';
import { removeMyExperience, updateMyExperience } from '$lib/server/api/v1/profile';

export const PUT = serve(updateMyExperience);
export const DELETE = serve(removeMyExperience);
