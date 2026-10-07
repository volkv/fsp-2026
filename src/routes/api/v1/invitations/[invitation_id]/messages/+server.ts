import { serve } from '$lib/server/api/serve';
import { listOfferMessages, sendOfferMessage } from '$lib/server/api/v1/messages';

export const GET = serve(listOfferMessages);
export const POST = serve(sendOfferMessage);
