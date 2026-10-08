import { serve } from '$lib/server/api/serve';
import { getMyAccountDeletion, requestMyAccountDeletion } from '$lib/server/api/v1/account';

export const GET = serve(getMyAccountDeletion);
export const POST = serve(requestMyAccountDeletion);
