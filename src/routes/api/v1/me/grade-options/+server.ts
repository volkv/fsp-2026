import { serve } from '$lib/server/api/serve';
import { getMyGradeOptions } from '$lib/server/api/v1/grades';

export const GET = serve(getMyGradeOptions);
