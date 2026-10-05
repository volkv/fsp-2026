import { serve } from '$lib/server/api/serve';
import { resolveObjectionByOperator } from '$lib/server/api/v1/categories';

export const POST = serve(resolveObjectionByOperator);
