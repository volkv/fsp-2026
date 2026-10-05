import { serve } from '$lib/server/api/serve';
import { declareMyGrade } from '$lib/server/api/v1/grades';

export const POST = serve(declareMyGrade);
