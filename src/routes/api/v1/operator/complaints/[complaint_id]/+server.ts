import { serve } from '$lib/server/api/serve';
import { getComplaintCase } from '$lib/server/api/v1/complaints';

export const GET = serve(getComplaintCase);
