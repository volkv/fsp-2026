// Checks of the per-call access grant (docs/contracts.md, section 1.2).
//
// delegated_user_token:   Authorization: Bearer <FSP ID access token with scope fsp_achievements>
// service_with_assertion: Authorization: Bearer <client credentials token with scope fsp_achievements_service>
//                         X-FSP-Consent-Assertion: base64url(JSON {sourceAthleteId, consentEventId, issuedAt, expiresAt, signature})
//                         signature = hex HMAC-SHA-256 over the four fields joined by "\n", secret shared with the platform.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type Provider from 'oidc-provider';

import { HttpError, bearerToken, isRecord } from '../http.ts';
import { ACHIEVEMENTS_SCOPE, ACHIEVEMENTS_SERVICE_SCOPE } from '../oidc/parity.ts';

export const ASSERTION_HEADER = 'x-fsp-consent-assertion';
/** Longest allowed lifetime of an assertion. */
export const ASSERTION_MAX_LIFETIME_MS = 5 * 60 * 1000;
/** Tolerated clock difference for `issuedAt` in the future. */
const CLOCK_SKEW_MS = 60 * 1000;

export interface ConsentAssertion {
	sourceAthleteId: string;
	consentEventId: string;
	issuedAt: string;
	expiresAt: string;
	signature: string;
}

export type VerifiedGrant =
	| { kind: 'delegated_user_token'; subject: string; clientId: string }
	| { kind: 'service_with_assertion'; clientId: string; consentEventId: string };

function signingInput(a: Omit<ConsentAssertion, 'signature'>): string {
	return [a.sourceAthleteId, a.consentEventId, a.issuedAt, a.expiresAt].join('\n');
}

export function signAssertion(fields: Omit<ConsentAssertion, 'signature'>, secret: string): ConsentAssertion {
	return { ...fields, signature: createHmac('sha256', secret).update(signingInput(fields)).digest('hex') };
}

export function encodeAssertion(assertion: ConsentAssertion): string {
	return Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url');
}

function invalid(message: string): HttpError {
	return new HttpError(401, 'grant_invalid', message, { 'www-authenticate': 'Bearer error="invalid_token"' });
}

function mismatch(): HttpError {
	return new HttpError(403, 'grant_mismatch', 'the grant does not cover the requested athlete');
}

function decodeAssertion(header: string): ConsentAssertion {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
	} catch {
		throw invalid('consent assertion is not base64url JSON');
	}
	if (!isRecord(parsed)) throw invalid('consent assertion must be an object');
	const field = (name: keyof ConsentAssertion): string => {
		const value = parsed[name];
		if (typeof value !== 'string' || value === '') throw invalid(`consent assertion field ${name} is missing`);
		return value;
	};
	return {
		sourceAthleteId: field('sourceAthleteId'),
		consentEventId: field('consentEventId'),
		issuedAt: field('issuedAt'),
		expiresAt: field('expiresAt'),
		signature: field('signature')
	};
}

function checkAssertion(assertion: ConsentAssertion, secret: string, athleteId: string, now: number): void {
	const expected = Buffer.from(createHmac('sha256', secret).update(signingInput(assertion)).digest('hex'), 'utf8');
	const actual = Buffer.from(assertion.signature, 'utf8');
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		throw invalid('consent assertion signature is invalid');
	}
	const issuedAt = Date.parse(assertion.issuedAt);
	const expiresAt = Date.parse(assertion.expiresAt);
	if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) throw invalid('consent assertion times are not ISO 8601');
	if (expiresAt <= issuedAt || expiresAt - issuedAt > ASSERTION_MAX_LIFETIME_MS) {
		throw invalid('consent assertion lifetime must be positive and at most 5 minutes');
	}
	if (issuedAt > now + CLOCK_SKEW_MS) throw invalid('consent assertion is issued in the future');
	if (now >= expiresAt) throw invalid('consent assertion has expired');
	// Signed and valid, but for somebody else: the platform asked for an athlete the consent does not cover.
	if (assertion.sourceAthleteId !== athleteId) throw mismatch();
}

/** Verifies the grant of a call about `athleteId`; throws HttpError with `grant_invalid` or `grant_mismatch`. */
export async function verifyGrant(
	provider: Provider,
	assertionSecret: string,
	req: IncomingMessage,
	athleteId: string,
	now: number = Date.now()
): Promise<VerifiedGrant> {
	const token = bearerToken(req);
	if (!token) throw invalid('bearer token is required');

	const assertionHeader = req.headers[ASSERTION_HEADER];
	if (assertionHeader !== undefined) {
		if (typeof assertionHeader !== 'string') throw invalid('only one consent assertion is allowed');
		const service = await provider.ClientCredentials.find(token);
		if (!service?.clientId || !service.scope?.split(' ').includes(ACHIEVEMENTS_SERVICE_SCOPE)) {
			throw invalid(`service token with scope ${ACHIEVEMENTS_SERVICE_SCOPE} is required`);
		}
		const assertion = decodeAssertion(assertionHeader);
		checkAssertion(assertion, assertionSecret, athleteId, now);
		return { kind: 'service_with_assertion', clientId: service.clientId, consentEventId: assertion.consentEventId };
	}

	const user = await provider.AccessToken.find(token);
	if (!user?.accountId || !user.clientId || !user.scope?.split(' ').includes(ACHIEVEMENTS_SCOPE)) {
		throw invalid(`user access token with scope ${ACHIEVEMENTS_SCOPE} is required`);
	}
	if (user.accountId !== athleteId) throw mismatch();
	return { kind: 'delegated_user_token', subject: user.accountId, clientId: user.clientId };
}

/** Service token without an assertion: management calls that carry no personal data (webhook subscriptions). */
export async function verifyServiceToken(provider: Provider, req: IncomingMessage): Promise<string> {
	const token = bearerToken(req);
	if (!token) throw invalid('bearer token is required');
	const service = await provider.ClientCredentials.find(token);
	if (!service?.clientId || !service.scope?.split(' ').includes(ACHIEVEMENTS_SERVICE_SCOPE)) {
		throw invalid(`service token with scope ${ACHIEVEMENTS_SERVICE_SCOPE} is required`);
	}
	return service.clientId;
}
