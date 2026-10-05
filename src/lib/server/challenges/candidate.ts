// The candidate's side of the calls of companies (docs/domain.md, 13.12; contracts 10.1): the calls delivered to them,
// opening one, a solution or an approach, its withdrawal at any time. Opening a call does not refresh the profile; a
// submitted solution does — it is a confirmed action of the candidate (freshness of the ranking). A solution belongs to
// the candidate: a withdrawn one the company no longer sees.
import { and, desc, eq } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent } from '$lib/server/audit/record';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { Executor, Transaction } from '$lib/server/db';
import { challengeDeliveries, challengeSolutions, companies, companyChallenges } from '$lib/server/db/schema';
import { demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { invalid, refuse } from '$lib/server/invitations/errors';
import { candidateSide } from '$lib/server/invitations/records';
import type { ChallengeDeps } from './company';
import { companyNow } from './clock';

/** The longest solution or approach, in characters. */
export const SOLUTION_MAX = 20_000;

type DeliveryRow = typeof challengeDeliveries.$inferSelect;
type ChallengeRow = typeof companyChallenges.$inferSelect;
type SolutionRow = typeof challengeSolutions.$inferSelect;

export interface DeliveredChallenge {
	deliveryId: string;
	status: DeliveryRow['status'];
	deliveredAt: Date;
	openedAt: Date | null;
	remindedAt: Date | null;
	challenge: {
		id: string;
		companyName: string;
		title: string;
		statement: string;
		answerKind: 'solution' | 'approach';
		specialization: SpecializationKey;
		grades: GradeKey[];
		salary: { min: number; max: number; taxBase: 'gross' | 'net' };
		goal: string;
		timeLimitMinutes: number;
		endsAt: Date;
		/** The call takes solutions now: active and before its end on its clock. */
		open: boolean;
	};
	solution: {
		id: string;
		status: SolutionRow['status'];
		content: string | null;
		submittedAt: Date;
		decision: 'invited' | 'dismissed' | null;
	} | null;
}

function writer(subject: AccessSubject) {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.write', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	return side;
}

function reader(subject: AccessSubject) {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.read', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	return side;
}

async function viewsOf(
	executor: Executor,
	rows: readonly {
		delivery: DeliveryRow;
		challenge: ChallengeRow;
		companyName: string;
		solution: SolutionRow | null;
	}[],
	now: Date
): Promise<DeliveredChallenge[]> {
	const result: DeliveredChallenge[] = [];
	for (const { delivery, challenge, companyName, solution } of rows) {
		const at = await companyNow(executor, challenge.companyId, now);
		if (
			challenge.salaryMin === null ||
			challenge.salaryMax === null ||
			(challenge.salaryTaxBase !== 'gross' && challenge.salaryTaxBase !== 'net')
		) {
			throw new Error(`call ${challenge.id} has no full range in roubles`);
		}
		result.push({
			deliveryId: delivery.id,
			status: delivery.status,
			deliveredAt: delivery.deliveredAt,
			openedAt: delivery.openedAt,
			remindedAt: delivery.remindedAt,
			challenge: {
				id: challenge.id,
				companyName,
				title: challenge.title,
				statement: challenge.statement,
				answerKind: challenge.answerKind,
				specialization: challenge.specialization,
				grades: challenge.grades as GradeKey[],
				salary: { min: challenge.salaryMin, max: challenge.salaryMax, taxBase: challenge.salaryTaxBase },
				goal: challenge.goal,
				timeLimitMinutes: challenge.timeLimitMinutes,
				endsAt: challenge.endsAt,
				open: challenge.status === 'active' && at < challenge.endsAt
			},
			solution: solution && {
				id: solution.id,
				status: solution.status,
				content: solution.content,
				submittedAt: solution.submittedAt,
				decision: solution.companyDecision
			}
		});
	}
	return result;
}

/** The calls delivered to the candidate by companies within their reach (`GET /me/challenges`), newest first. */
export async function myChallenges(deps: ChallengeDeps, subject: AccessSubject): Promise<DeliveredChallenge[]> {
	const side = reader(subject);
	const session = await demoSessionOfUser(deps.db, side.userId);
	const rows = await deps.db
		.select({
			delivery: challengeDeliveries,
			challenge: companyChallenges,
			companyName: companies.displayName,
			demoSessionId: companies.demoSessionId,
			demoOriginal: companies.demoOriginal,
			solution: challengeSolutions
		})
		.from(challengeDeliveries)
		.innerJoin(companyChallenges, eq(companyChallenges.id, challengeDeliveries.challengeId))
		.innerJoin(companies, eq(companies.id, companyChallenges.companyId))
		.leftJoin(challengeSolutions, eq(challengeSolutions.deliveryId, challengeDeliveries.id))
		.where(eq(challengeDeliveries.candidateId, side.candidateId))
		.orderBy(desc(challengeDeliveries.deliveredAt));
	return viewsOf(
		deps.db,
		rows.filter((row) => inDemoScope(row, session)),
		deps.now()
	);
}

async function lockOwnDelivery(tx: Transaction, side: { userId: string; candidateId: string }, deliveryId: string) {
	const [row] = await tx
		.select({
			delivery: challengeDeliveries,
			challenge: companyChallenges,
			companyName: companies.displayName,
			demoSessionId: companies.demoSessionId,
			demoOriginal: companies.demoOriginal
		})
		.from(challengeDeliveries)
		.innerJoin(companyChallenges, eq(companyChallenges.id, challengeDeliveries.challengeId))
		.innerJoin(companies, eq(companies.id, companyChallenges.companyId))
		.where(and(eq(challengeDeliveries.id, deliveryId), eq(challengeDeliveries.candidateId, side.candidateId)))
		.for('update', { of: challengeDeliveries });
	if (!row || !inDemoScope(row, await demoSessionOfUser(tx, side.userId))) throw refuse('not_found', 'not_addressee');
	return row;
}

/** The candidate opens a delivered call: `delivered → opened`. Opening is not a confirmed action. */
export async function openDelivery(
	deps: ChallengeDeps,
	subject: AccessSubject,
	deliveryId: string
): Promise<DeliveredChallenge> {
	const side = reader(subject);
	return deps.db.transaction(async (tx) => {
		const row = await lockOwnDelivery(tx, side, deliveryId);
		let delivery = row.delivery;
		if (delivery.status === 'delivered') {
			const [opened] = await tx
				.update(challengeDeliveries)
				.set({ status: 'opened', openedAt: deps.now() })
				.where(eq(challengeDeliveries.id, delivery.id))
				.returning();
			if (!opened) throw new Error(`delivery ${delivery.id} disappeared`);
			delivery = opened;
		}
		const [solution] = await tx.select().from(challengeSolutions).where(eq(challengeSolutions.deliveryId, delivery.id));
		const [view] = await viewsOf(
			tx,
			[{ delivery, challenge: row.challenge, companyName: row.companyName, solution: solution ?? null }],
			deps.now()
		);
		if (!view) throw new Error('view of a delivery was not built');
		return view;
	});
}

function closedChallenge() {
	return refuse('conflict', 'challenge_closed', [
		{ code: 'challenge_closed', message: 'Вызов закрыт: решения больше не принимаются' }
	]);
}

/**
 * A solution or an approach to a delivered call (`POST /me/challenges/{delivery_id}/solutions`): the call is active and
 * before its end on its clock (`409 challenge_closed`), one solution per delivery — a withdrawn one may be sent again.
 */
export async function submitSolution(
	deps: ChallengeDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	deliveryId: string,
	content: string
): Promise<DeliveredChallenge> {
	const side = writer(subject);
	const text = content.trim();
	if (text === '' || text.length > SOLUTION_MAX) throw invalid('content', `Решение — от 1 до ${SOLUTION_MAX} символов`);
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		await requireProcessingConsent(tx, side.candidateId, now);
		const row = await lockOwnDelivery(tx, side, deliveryId);
		const at = await companyNow(tx, row.challenge.companyId, now);
		if (row.challenge.status !== 'active' || at >= row.challenge.endsAt || row.delivery.status === 'expired') {
			throw closedChallenge();
		}
		const [existing] = await tx
			.select()
			.from(challengeSolutions)
			.where(eq(challengeSolutions.deliveryId, row.delivery.id))
			.for('update');
		let solution: SolutionRow | undefined;
		if (existing?.status === 'submitted') {
			throw refuse('conflict', 'already_submitted', [{ code: 'already_submitted', message: 'Решение уже отправлено' }]);
		}
		if (existing) {
			[solution] = await tx
				.update(challengeSolutions)
				.set({
					status: 'submitted',
					content: text,
					submittedAt: now,
					withdrawnAt: null,
					companyDecision: null,
					decidedAt: null,
					decidedByMemberId: null
				})
				.where(eq(challengeSolutions.id, existing.id))
				.returning();
		} else {
			[solution] = await tx
				.insert(challengeSolutions)
				.values({ deliveryId: row.delivery.id, content: text, submittedAt: now, status: 'submitted' })
				.returning();
		}
		if (!solution) throw new Error('solution was not written');
		const [delivery] = await tx
			.update(challengeDeliveries)
			.set({ status: 'solved', openedAt: row.delivery.openedAt ?? now })
			.where(eq(challengeDeliveries.id, row.delivery.id))
			.returning();
		if (!delivery) throw new Error(`delivery ${row.delivery.id} disappeared`);
		await recordAuditEvent(tx, {
			action: 'challenge.solution_submitted',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'challenge_solution', id: solution.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { challenge_id: row.challenge.id },
			occurredAt: now
		});
		const [view] = await viewsOf(
			tx,
			[{ delivery, challenge: row.challenge, companyName: row.companyName, solution }],
			now
		);
		if (!view) throw new Error('view of a delivery was not built');
		return view;
	});
}

/** The candidate withdraws the solution (`DELETE /me/challenges/{delivery_id}/solutions/{id}`): its text is cleared. */
export async function withdrawSolution(
	deps: ChallengeDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	deliveryId: string,
	solutionId: string
): Promise<void> {
	const side = writer(subject);
	await deps.db.transaction(async (tx) => {
		const now = deps.now();
		const row = await lockOwnDelivery(tx, side, deliveryId);
		const [solution] = await tx
			.update(challengeSolutions)
			.set({ status: 'withdrawn', content: null, withdrawnAt: now })
			.where(
				and(
					eq(challengeSolutions.id, solutionId),
					eq(challengeSolutions.deliveryId, row.delivery.id),
					eq(challengeSolutions.status, 'submitted')
				)
			)
			.returning({ id: challengeSolutions.id });
		if (!solution) throw refuse('not_found', 'no_solution');
		await tx
			.update(challengeDeliveries)
			.set({ status: 'opened', openedAt: row.delivery.openedAt ?? now })
			.where(eq(challengeDeliveries.id, row.delivery.id));
		await recordAuditEvent(tx, {
			action: 'challenge.solution_withdrawn',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'challenge_solution', id: solution.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			occurredAt: now
		});
	});
}

/** The candidate is not interested (`POST /me/challenges/{delivery_id}/dismissal`): the call leaves the list of new ones. */
export async function dismissDelivery(deps: ChallengeDeps, subject: AccessSubject, deliveryId: string): Promise<void> {
	const side = writer(subject);
	await deps.db.transaction(async (tx) => {
		const row = await lockOwnDelivery(tx, side, deliveryId);
		if (row.delivery.status !== 'delivered' && row.delivery.status !== 'opened') {
			throw refuse('conflict', 'not_open', [{ code: 'not_open', message: 'Вызов уже решён или закрыт' }]);
		}
		await tx
			.update(challengeDeliveries)
			.set({ status: 'dismissed', openedAt: row.delivery.openedAt ?? deps.now() })
			.where(eq(challengeDeliveries.id, row.delivery.id));
	});
}
