import { serve } from '$lib/server/api/serve';
import { listMyResumes, uploadMyResume } from '$lib/server/api/v1/resumes';

export const GET = serve(listMyResumes);
export const POST = serve(uploadMyResume);
