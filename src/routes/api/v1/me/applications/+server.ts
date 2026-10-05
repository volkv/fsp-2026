import { serve } from '$lib/server/api/serve';
import { createApplication, listMyApplications } from '$lib/server/api/v1/applications';

export const GET = serve(listMyApplications);
export const POST = serve(createApplication);
