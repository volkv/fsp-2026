import { serve } from '$lib/server/api/serve';
import { getMyCurrentResume } from '$lib/server/api/v1/resumes';

export const GET = serve(getMyCurrentResume);
