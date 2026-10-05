import { serve } from '$lib/server/api/serve';
import { assignObjectionToMe } from '$lib/server/api/v1/categories';

export const POST = serve(assignObjectionToMe);
