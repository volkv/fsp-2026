import { serve } from '$lib/server/api/serve';
import { markViewed } from '$lib/server/api/v1/invitations';

export const POST = serve(markViewed);
