import { serve } from '$lib/server/api/serve';
import { disclosedContacts } from '$lib/server/api/v1/invitations';

export const GET = serve(disclosedContacts);
