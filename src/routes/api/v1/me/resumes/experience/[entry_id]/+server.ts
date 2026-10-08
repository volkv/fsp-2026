import { serve } from '$lib/server/api/serve';
import { correctMyResumeExperience } from '$lib/server/api/v1/resumes';

export const PUT = serve(correctMyResumeExperience);
