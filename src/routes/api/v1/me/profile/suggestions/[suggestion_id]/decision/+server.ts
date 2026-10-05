import { serve } from '$lib/server/api/serve';
import { decideProfileSuggestion } from '$lib/server/api/v1/profile';

export const POST = serve(decideProfileSuggestion);
