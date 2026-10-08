import { serve } from '$lib/server/api/serve';
import { deleteMyResume } from '$lib/server/api/v1/resumes';

export const DELETE = serve(deleteMyResume);
