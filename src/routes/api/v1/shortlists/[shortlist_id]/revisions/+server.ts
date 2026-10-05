import { serve } from '$lib/server/api/serve';
import { createShortlistRevision } from '$lib/server/api/v1/shortlists';

export const POST = serve(createShortlistRevision);
