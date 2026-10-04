import { serve } from '$lib/server/api/serve';
import { getOneInvitation } from '$lib/server/api/v1/invitations';

export const GET = serve(getOneInvitation);
