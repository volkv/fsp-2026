import { serve } from '$lib/server/api/serve';
import { reviseInvitationTerms } from '$lib/server/api/v1/invitations';

export const POST = serve(reviseInvitationTerms);
