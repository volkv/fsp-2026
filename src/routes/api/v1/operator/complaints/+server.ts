import { serve } from '$lib/server/api/serve';
import { listComplaints } from '$lib/server/api/v1/complaints';

export const GET = serve(listComplaints);
