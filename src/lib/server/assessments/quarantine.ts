// Quarantine of a family of the bank (docs/domain.md, 10.5): a person — the administrator of the bank, never a demo
// actor — takes a family out of serving with a reason, and puts it back; both are journalled. The online signals of
// `leak.ts` only point at a family. A quarantine holds for attempts started while it is in force: an attempt started before keeps its plan, its
// clusters and its decision. A family is quarantined only if the release still serves every history the policy allows
// without it and without the families already in quarantine (`capacityChecks`); otherwise the administrator gets the
// shortages and a refusal, and no candidate meets a test that cannot be assembled.
import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm';
import { requireStandChange } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { auditActorOf, conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database, Executor } from '$lib/server/db';
import {
	QUARANTINE_REASONS,
	bankFamilyQuarantines,
	bankReleases,
	testAttempts,
	testItems
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { releaseInForce, type ServedRelease } from './bank-store';
import { capacityChecks, type CapacityShortage } from './contract/bank';
import { SPECIALIZATION_KEYS, type SpecializationKey } from './contract/catalog';
import { PROCEDURE } from './contract/procedure';
import { LEAK_DETECTOR, familyFindings, type FamilyFinding } from './leak';
import type { ManifestFamily } from './release';

export { QUARANTINE_REASONS };
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/** Keys of the families of a specialization quarantined at `at` (the quarantine began no later than `at`). */
export async function quarantinedAt(executor: Executor, specialization: string, at: Date): Promise<Set<string>> {
	const rows = await executor
		.select({ familyKey: bankFamilyQuarantines.familyKey })
		.from(bankFamilyQuarantines)
		.where(
			and(
				eq(bankFamilyQuarantines.specialization, specialization),
				isNull(bankFamilyQuarantines.liftedAt),
				lte(bankFamilyQuarantines.quarantinedAt, at)
			)
		);
	return new Set(rows.map((r) => r.familyKey));
}

/**
 * The families of a release that serve an attempt started at `startedAt`: those not in a quarantine begun by then. An
 * attempt started before a quarantine keeps the family.
 */
export async function servingFamilies(
	executor: Executor,
	release: ServedRelease,
	startedAt: Date
): Promise<ManifestFamily[]> {
	const out = await quarantinedAt(executor, release.specialization, startedAt);
	return out.size === 0 ? release.families : release.families.filter((f) => !out.has(f.descriptor.key));
}

/** What the release lacks for some history of the policy without `excluded` families; empty — it serves them all. */
export function shortagesWithout(release: ServedRelease, excluded: ReadonlySet<string>): CapacityShortage[] {
	const families = release.families.map((f) => f.descriptor).filter((f) => !excluded.has(f.key));
	return capacityChecks({ specialization: release.specialization, families }, PROCEDURE).flatMap((check) =>
		check.shortages.map((s) => ({ ...s, step: `${check.grade} ${s.step}` }))
	);
}

const isSpecialization = (value: string): value is SpecializationKey =>
	(SPECIALIZATION_KEYS as readonly string[]).includes(value);

export interface QuarantineInput {
	specialization: string;
	familyKey: string;
	reason: QuarantineReason;
	note: string | null;
}

async function releaseOf(executor: Executor, specialization: string): Promise<ServedRelease> {
	if (!isSpecialization(specialization)) throw new ApiError('not_found');
	const release = await releaseInForce(executor, specialization);
	if (!release) throw conflict('no_release', 'У специализации нет действующего выпуска банка', 'specialization');
	return release;
}

/** Quarantines a family of the release in force (`policy.manage`); the shortages it would cause refuse it. */
export async function quarantineFamily(
	database: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	input: QuarantineInput,
	now: Date
): Promise<void> {
	requirePermission(subject, 'policy.manage', null);
	const userId = sessionUserId(subject);
	// The bank serves every visitor of a demonstration stand: a demo actor does not change it.
	await requireStandChange(database, subject);
	if (input.note !== null && input.note.length > 500) {
		throw invalid([{ path: 'note', code: 'too_long', message: 'Комментарий — не длиннее 500 символов' }]);
	}
	await database.transaction(async (tx) => {
		// One quarantine at a time per specialization: the capacity is checked against the ones in force.
		await tx
			.select({ id: bankReleases.id })
			.from(bankReleases)
			.where(and(eq(bankReleases.specialization, input.specialization), eq(bankReleases.status, 'released')))
			.for('update');
		const release = await releaseOf(tx, input.specialization);
		if (!release.families.some((f) => f.descriptor.key === input.familyKey)) {
			throw conflict('family_not_released', 'Этого семейства нет в действующем выпуске', 'family');
		}
		const already = await quarantinedAt(tx, input.specialization, now);
		if (already.has(input.familyKey)) throw conflict('already_quarantined', 'Семейство уже в карантине', 'family');
		const shortages = shortagesWithout(release, new Set([...already, input.familyKey]));
		if (shortages.length > 0) {
			const where = [...new Set(shortages.map((s) => `${s.step}: ${s.block}`))].slice(0, 5).join('; ');
			throw conflict(
				'bank_capacity_exhausted',
				`Без этого семейства выпуск не соберёт тест для всех историй политики (${where}). Нужен новый выпуск с заменой семейства.`,
				'family'
			);
		}
		const [row] = await tx
			.insert(bankFamilyQuarantines)
			.values({
				specialization: input.specialization,
				familyKey: input.familyKey,
				reason: input.reason,
				note: input.note,
				quarantinedBy: userId,
				quarantinedAt: now
			})
			.returning({ id: bankFamilyQuarantines.id });
		if (!row) throw new Error('quarantine was not inserted');
		await recordAuditEvent(tx, {
			action: 'bank.family_quarantined',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'bank_family', id: `${input.specialization}/${input.familyKey}` },
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			occurredAt: now,
			details: { release_id: release.id, reason: input.reason, quarantine_id: row.id }
		});
	});
}

/** Puts a quarantined family back into serving (`policy.manage`). */
export async function liftQuarantine(
	database: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	input: { specialization: string; familyKey: string },
	now: Date
): Promise<void> {
	requirePermission(subject, 'policy.manage', null);
	const userId = sessionUserId(subject);
	// The bank serves every visitor of a demonstration stand: a demo actor does not change it.
	await requireStandChange(database, subject);
	await database.transaction(async (tx) => {
		const [row] = await tx
			.update(bankFamilyQuarantines)
			.set({ liftedBy: userId, liftedAt: now })
			.where(
				and(
					eq(bankFamilyQuarantines.specialization, input.specialization),
					eq(bankFamilyQuarantines.familyKey, input.familyKey),
					isNull(bankFamilyQuarantines.liftedAt)
				)
			)
			.returning({ id: bankFamilyQuarantines.id, reason: bankFamilyQuarantines.reason });
		if (!row) throw conflict('not_quarantined', 'Семейство не в карантине', 'family');
		await recordAuditEvent(tx, {
			action: 'bank.family_restored',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'bank_family', id: `${input.specialization}/${input.familyKey}` },
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			occurredAt: now,
			details: { reason: row.reason, quarantine_id: row.id }
		});
	});
}

/** Scored computed items of live attempts of a specialization in the window: seeded attempts of the demo aside. */
async function liveResponses(executor: Executor, specialization: string, now: Date) {
	const since = new Date(now.getTime() - LEAK_DETECTOR.windowDays * 86_400_000);
	const rows = await executor
		.select({
			attemptId: testItems.attemptId,
			familyKey: testItems.familyKey,
			angoff: testItems.angoff,
			score: testItems.score,
			answeredAt: testItems.answeredAt
		})
		.from(testItems)
		.innerJoin(testAttempts, eq(testAttempts.id, testItems.attemptId))
		.where(
			and(
				eq(testAttempts.specialization, specialization),
				eq(testAttempts.seeded, false),
				eq(testItems.practice, false),
				eq(testItems.status, 'scored'),
				gt(testItems.answeredAt, since)
			)
		);
	return rows.map((row) => {
		if (row.score === null || row.answeredAt === null)
			throw new Error(`a scored item of ${row.attemptId} has no score`);
		return {
			attemptId: row.attemptId,
			familyKey: row.familyKey,
			angoff: row.angoff,
			correct: row.score === 1,
			answeredAt: row.answeredAt
		};
	});
}

export interface QuarantineView {
	familyKey: string;
	reason: QuarantineReason;
	note: string | null;
	quarantinedAt: Date;
	liftedAt: Date | null;
}

export interface LeakSpecialization {
	specialization: SpecializationKey;
	releaseId: string;
	/** Keys of the families of the release, for a quarantine without a signal (a published family). */
	families: string[];
	/** Live computed answers of the window. */
	responses: number;
	findings: (FamilyFinding & {
		quarantined: boolean;
		/** What the release would lack without the family (and the ones in quarantine); empty — it can be quarantined. */
		shortages: CapacityShortage[];
	})[];
	quarantines: QuarantineView[];
}

/** The panel of the bank: the online signals and the quarantines of every released specialization. */
export async function leakPanel(executor: Executor, subject: AccessSubject, now: Date): Promise<LeakSpecialization[]> {
	requirePermission(subject, 'policy.manage', null);
	const result: LeakSpecialization[] = [];
	for (const specialization of SPECIALIZATION_KEYS) {
		const release = await releaseInForce(executor, specialization);
		if (!release) continue;
		const responses = await liveResponses(executor, specialization, now);
		const out = await quarantinedAt(executor, specialization, now);
		const history = await executor
			.select()
			.from(bankFamilyQuarantines)
			.where(eq(bankFamilyQuarantines.specialization, specialization))
			.orderBy(desc(bankFamilyQuarantines.quarantinedAt))
			.limit(50);
		result.push({
			specialization,
			releaseId: release.id,
			families: release.families.map((f) => f.descriptor.key).sort(),
			responses: responses.length,
			findings: familyFindings(responses).map((finding) => ({
				...finding,
				quarantined: out.has(finding.familyKey),
				shortages:
					finding.signal && !out.has(finding.familyKey)
						? shortagesWithout(release, new Set([...out, finding.familyKey]))
						: []
			})),
			quarantines: history.map((row) => ({
				familyKey: row.familyKey,
				reason: row.reason,
				note: row.note,
				quarantinedAt: row.quarantinedAt,
				liftedAt: row.liftedAt
			}))
		});
	}
	return result;
}
