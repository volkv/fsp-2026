import { error } from '@sveltejs/kit';
import { auditActorOf, recordAuditEvent } from '$lib/server/audit/record';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import {
	checkReceiptSignature,
	fromSimulator,
	receiptKeySet,
	receiptStatementSchema,
	verifyReceipt
} from '$lib/server/fsp/receipts';
import type { PageServerLoad } from './$types';

/** 128 random bits in base32 without padding (domain 9.6). */
const HANDLE = /^[a-z2-7]{26}$/u;

/**
 * The public check of a receipt, without signing in (domain 9.6; the same logic as `GET /api/v1/verify/{handle}`):
 * what was verified, by which source and when, what it does not confirm, its status now and whether the signature
 * holds against the published keys. Nothing about the person is read or shown.
 */
export const load: PageServerLoad = async (event) => {
	// Over the rate limit the hook lets the page through to render the refusal in the layout of the site.
	if (event.locals.rateLimited) {
		error(429, { message: 'Слишком много проверок подряд', requestId: event.locals.requestId });
	}
	const { handle } = event.params;
	if (!HANDLE.test(handle)) error(404, { message: 'Квитанция не найдена', requestId: event.locals.requestId });
	const database = db();
	const receipt = await verifyReceipt(database, handle);
	await recordAuditEvent(database, {
		action: 'receipt.verified',
		outcome: receipt ? 'success' : 'denied',
		actor: auditActorOf(event.locals.actor),
		requestId: event.locals.requestId,
		ip: event.getClientAddress(),
		userAgent: event.request.headers.get('user-agent'),
		details: { handle, result: receipt?.status ?? 'not_found' }
	});
	if (!receipt) error(404, { message: 'Квитанция не найдена', requestId: event.locals.requestId });
	event.setHeaders({ 'cache-control': 'no-store' });
	const statement = receiptStatementSchema.parse(receipt.statement);
	return {
		handle,
		status: receipt.status,
		level: receipt.disclosureLevel,
		statement: {
			source: statement.source,
			factType: statement.fact_type,
			verifiedAt: statement.verified_at,
			asserts: statement.asserts,
			doesNotAssert: statement.does_not_assert,
			recordCommitment: statement.record_commitment,
			issuer: statement.issuer.platform,
			simulator: fromSimulator(statement)
		},
		signingKeyId: receipt.signingKeyId,
		signature: checkReceiptSignature(
			receipt.statement,
			receipt.signature,
			receipt.signingKeyId,
			receiptKeySet(config().crypto.receiptSigningKeys)
		)
	};
};
