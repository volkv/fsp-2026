import { json } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { receiptKeySet } from '$lib/server/fsp/receipts';
import type { RequestHandler } from './$types';

/**
 * Public keys of receipt signatures (contracts 5.5): a JWKS of `OKP`/`Ed25519` keys by `kid`, the `signing_key_id`
 * of a receipt. Every key of the ring is published, so receipts signed before a key rotation still verify.
 */
export const GET: RequestHandler = () =>
	json(receiptKeySet(config().crypto.receiptSigningKeys), {
		headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }
	});
