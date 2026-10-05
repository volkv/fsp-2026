import { serve } from '$lib/server/api/serve';
import { shortlistWhatIf } from '$lib/server/api/v1/shortlists';

export const GET = serve(shortlistWhatIf);
