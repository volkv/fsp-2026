import { serve } from '$lib/server/api/serve';
import { reportProcess } from '$lib/server/api/v1/hiring';

export const POST = serve(reportProcess);
