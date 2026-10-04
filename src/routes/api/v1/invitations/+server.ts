import { serve } from '$lib/server/api/serve';
import { listMyInvitations, sendInvitation } from '$lib/server/api/v1/invitations';

export const GET = serve(listMyInvitations);
export const POST = serve(sendInvitation);
