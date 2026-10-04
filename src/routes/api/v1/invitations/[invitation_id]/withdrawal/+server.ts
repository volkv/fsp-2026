import { serve } from '$lib/server/api/serve';
import { withdraw } from '$lib/server/api/v1/invitations';

export const POST = serve(withdraw);
