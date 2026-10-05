import { serve } from '$lib/server/api/serve';
import { answerTestItem } from '$lib/server/api/v1/tests';

export const POST = serve(answerTestItem);
