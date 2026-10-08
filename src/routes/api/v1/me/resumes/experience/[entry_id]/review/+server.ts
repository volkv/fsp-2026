import { serve } from '$lib/server/api/serve';
import { reviewMyResumeExperience } from '$lib/server/api/v1/resumes';

export const POST = serve(reviewMyResumeExperience);
