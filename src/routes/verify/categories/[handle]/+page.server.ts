import { error, fail } from '@sveltejs/kit';
import { categoryTitle, attestationStatementSchema } from '$lib/server/attestations/statement';
import { ATTESTATION_HANDLE, checkHolder, verifyAttestation } from '$lib/server/attestations/verify';
import { auditActorOf, recordAuditEvent } from '$lib/server/audit/record';
import { formText } from '$lib/server/http/form';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { checkReceiptSignature, receiptKeySet } from '$lib/server/fsp/receipts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The public check of a confirmation of a category, without signing in (domain 12.9; the same logic as
 * `GET /api/v1/verify/categories/{handle}`): the specialization and the grade, the blocks and the stack the test
 * confirmed, the versions of the ground, what is not checked, the status now and whether the signature holds. Nothing
 * about the person is read or shown; whether it is the presenter's is checked by the name and the holder code.
 */
export const load: PageServerLoad = async (event) => {
	// Over the rate limit the hook lets the page through to render the refusal in the layout of the site.
	if (event.locals.rateLimited) {
		error(429, { message: 'Слишком много проверок подряд', requestId: event.locals.requestId });
	}
	const { handle } = event.params;
	if (!ATTESTATION_HANDLE.test(handle))
		error(404, { message: 'Подтверждение не найдено', requestId: event.locals.requestId });
	const database = db();
	const verified = await verifyAttestation(database, handle);
	await recordAuditEvent(database, {
		action: 'attestation.verified',
		outcome: verified ? 'success' : 'denied',
		actor: auditActorOf(event.locals.actor),
		requestId: event.locals.requestId,
		ip: event.getClientAddress(),
		userAgent: event.request.headers.get('user-agent'),
		details: { handle, result: verified?.status ?? 'not_found' }
	});
	if (!verified) error(404, { message: 'Подтверждение не найдено', requestId: event.locals.requestId });
	event.setHeaders({ 'cache-control': 'no-store' });
	const statement = attestationStatementSchema.parse(verified.statement);
	const vocabulary = await currentCandidateVocabulary(database);
	const skills = vocabulary === null ? {} : vocabularyLabels(vocabulary).skills;
	const title = categoryTitle(statement.specialization, statement.grade);
	return {
		handle,
		status: verified.status,
		title,
		statement: {
			blocks: statement.confirmed_blocks.map((block) => block.title),
			skills: statement.confirmed_skill_keys.map((key) => skills[key] ?? key),
			catalogVersion: statement.catalog_version,
			bankReleaseId: statement.bank_release_id,
			decidedOn: statement.decided_on,
			issuedOn: statement.issued_on,
			doesNotAssert: statement.does_not_assert,
			judgementNote: statement.judgement.note,
			holderCommitment: statement.holder_commitment,
			issuer: statement.issuer.platform
		},
		endedOn: verified.endedAt === null ? null : verified.endedAt.toISOString().slice(0, 10),
		annulReason: verified.annulReason,
		reissued: verified.reissued,
		current:
			verified.currentGrade === null
				? null
				: {
						grade: categoryTitle(statement.specialization, verified.currentGrade.grade).grade,
						assignedOn: verified.currentGrade.assignedOn
					},
		signingKeyId: verified.signingKeyId,
		signature: checkReceiptSignature(
			verified.statement,
			verified.signature,
			verified.signingKeyId,
			receiptKeySet(config().crypto.receiptSigningKeys)
		),
		/** A holder code the candidate put into the link they gave: the presenter types only the name. */
		holderCode: event.url.searchParams.get('code') ?? ''
	};
};

export const actions: Actions = {
	holder: async (event) => {
		const { handle } = event.params;
		if (!ATTESTATION_HANDLE.test(handle))
			error(404, { message: 'Подтверждение не найдено', requestId: event.locals.requestId });
		const form = await event.request.formData();
		const fullName = formText(form, 'full_name').trim();
		const code = formText(form, 'code').trim();
		if (fullName.length === 0 || code.length === 0) {
			return fail(400, { holder: { problem: 'Укажите ФИО и код владельца' } });
		}
		if (fullName.length > 300 || code.length > 64)
			return fail(400, { holder: { problem: 'Слишком длинное значение' } });
		const database = db();
		const matches = await checkHolder(database, handle, { fullName, holderCode: code });
		await recordAuditEvent(database, {
			action: 'attestation.holder_checked',
			outcome: matches === null ? 'denied' : 'success',
			actor: auditActorOf(event.locals.actor),
			requestId: event.locals.requestId,
			ip: event.getClientAddress(),
			userAgent: event.request.headers.get('user-agent'),
			details: { handle, result: matches === null ? 'not_found' : matches ? 'matches' : 'differs' }
		});
		if (matches === null) error(404, { message: 'Подтверждение не найдено', requestId: event.locals.requestId });
		return { holder: { matches } };
	}
};
