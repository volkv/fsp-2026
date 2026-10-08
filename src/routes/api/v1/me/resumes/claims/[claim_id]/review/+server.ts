import { serve } from '$lib/server/api/serve';
import { reviewMyResumeClaim } from '$lib/server/api/v1/resumes';

export const POST = serve(reviewMyResumeClaim);
