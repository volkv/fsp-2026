import { serve } from '$lib/server/api/serve';
import { readOfferMessages } from '$lib/server/api/v1/messages';

export const POST = serve(readOfferMessages);
