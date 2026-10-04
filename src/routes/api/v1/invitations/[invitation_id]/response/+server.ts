import { serve } from '$lib/server/api/serve';
import { respondInvitation } from '$lib/server/api/v1/invitations';

export const POST = serve(respondInvitation);
