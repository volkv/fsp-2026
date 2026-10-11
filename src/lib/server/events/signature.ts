// The signature of an outgoing webhook by the Standard Webhooks specification (standardwebhooks.com): the receiver
// checks it with any library of the specification, or with a few lines of HMAC (the API document has an example).
import { createHmac } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';

/**
 * One signature of the `webhook-signature` header: `v1,<base64 of HMAC-SHA-256>` of `{id}.{timestamp}.{body}`, keyed by
 * the bytes the base64 part of the `whsec_…` secret encodes. During a rotation the header carries one per secret,
 * separated by a space.
 */
export function webhookSignature(secret: string, id: string, timestamp: number, body: string): string {
	if (!secret.startsWith(SECRET_PREFIX)) throw new Error('a webhook secret starts with whsec_');
	const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
	return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`;
}
