import { serve } from '$lib/server/api/serve';
import { getMyGradeHint } from '$lib/server/api/v1/grades';

export const GET = serve(getMyGradeHint);
