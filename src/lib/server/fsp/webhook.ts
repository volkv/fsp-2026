// Webhook «achievements updated» (docs/contracts.md, section 1.5): verify the signature and the time, deduplicate by
// the source event id, and enqueue `fsp.sync` for every known athlete with an active link and consent — all in the
// transaction that records the inbound event. Heavy work happens only in the job.
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database } from '$lib/server/db';
import { athleteLinks, candidates, inboundEvents } from '$lib/server/db/schema';
import { ApiError, errorResponse } from '$lib/server/errors/api-error';
import { enqueueJob } from '$lib/server/jobs/queue';
import { effectiveFspImportConsent } from './consent';
import type { AchievementsSource } from './types';

interface WebhookRequest {
	headers: Headers;
	rawBody: Uint8Array;
	requestId: string;
	ip: string | null;
	userAgent: string | null;
}

/** Handles one delivery; answers `202 { accepted: true }` for an accepted or repeated event, `401` otherwise. */
export async function receiveFspWebhook(
	db: Database,
	source: AchievementsSource,
	request: WebhookRequest
): Promise<Response> {
	const verified = source.verifyWebhook({
		headers: Object.fromEntries(request.headers.entries()),
		rawBody: request.rawBody
	});
	if (!verified.ok) {
		await recordAuditEvent(db, {
			action: 'fsp.webhook_rejected',
			outcome: 'denied',
			actor: { kind: 'anonymous' },
			requestId: request.requestId,
			ip: request.ip,
			userAgent: request.userAgent,
			details: { reason: verified.error.code }
		});
		return errorResponse(new ApiError('unauthenticated', { message: 'Подпись вебхука не принята' }), request.requestId);
	}
	const event = verified.value;
	const bodyHash = createHash('sha256').update(request.rawBody).digest('hex');

	await db.transaction(async (tx) => {
		const [recorded] = await tx
			.insert(inboundEvents)
			.values({
				source: 'fsp',
				eventId: event.eventId,
				eventType: event.type,
				occurredAt: new Date(event.occurredAt),
				payloadSha256: bodyHash
			})
			.onConflictDoNothing({ target: [inboundEvents.source, inboundEvents.eventId] })
			.returning({ id: inboundEvents.id });
		// A repeated delivery of an event already taken: nothing to do (contracts 1.5, step 2).
		if (!recorded) return;

		// Unknown athletes are neither stored nor reported back (step 4).
		const links = await tx
			.select({ linkId: athleteLinks.id, candidateId: candidates.id })
			.from(athleteLinks)
			.innerJoin(candidates, eq(candidates.userId, athleteLinks.userId))
			.where(
				and(
					eq(athleteLinks.source, 'fsp'),
					eq(athleteLinks.status, 'active'),
					// No link of a demo session is updated by webhooks or result batches, neither a clone's nor one of an account
					// signed up within the session: such an account imports by its own consent through `fsp.sync` (domain 19.3).
					isNull(athleteLinks.demoSessionId),
					inArray(athleteLinks.sourceAthleteId, event.athleteIds)
				)
			);
		const now = new Date();
		for (const link of links) {
			const consentEventId = await effectiveFspImportConsent(tx, link.candidateId, now);
			if (consentEventId === null) continue;
			await enqueueJob(
				tx,
				'fsp.sync',
				{ athlete_link_id: link.linkId },
				{ inputVersion: `${link.linkId}:${consentEventId}`, createdBy: { kind: 'webhook', id: recorded.id } }
			);
		}
	});

	return new Response(JSON.stringify({ accepted: true }), {
		status: 202,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': request.requestId }
	});
}
