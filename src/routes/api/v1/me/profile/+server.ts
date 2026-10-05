import { serve } from '$lib/server/api/serve';
import { getMyProfile, updateMyProfile } from '$lib/server/api/v1/profile';

export const GET = serve(getMyProfile);
export const PUT = serve(updateMyProfile);
