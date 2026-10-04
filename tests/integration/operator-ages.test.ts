// Conflicts of the birth date against the database (domain 7.2): the queue of the operator, the case with the name
// and the address opened under the journal, and the decision by a document — the date becomes verified, the regime of
// age follows from it (an adult, or a minor whose profile leaves the catalog without a verified representative), the
// journal gets `age.verified` with codes only, the matches are recomputed, the candidate is notified of the regime and
// never of the date. An age at which no profile may be kept is refused and changes nothing; a decided conflict is not
// decided again; without the right nothing is read or written. The first screen of the cabinet counts the queue.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { RequestMeta } from '$lib/server/auth/context';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { auditEvents, candidates, jobs, notifications, staffRoles } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { notificationFacts } from '$lib/server/notifications/content';
import { openNotification } from '$lib/server/notifications/inbox';
import { notificationLetter } from '$lib/server/notifications/templates';
import { isNotificationType } from '$lib/server/notifications/types';
import { ageCase, ageConflictCount, ageConflictQueue, resolveAgeConflict } from '$lib/server/operator/ages';
import { operatorOverview } from '$lib/server/operator/overview';
import { ageBand } from '$lib/server/visibility/age';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser } from '../helpers/factories';

const NOW = new Date('2026-09-26T10:00:00Z');
const meta: RequestMeta = { requestId: 'req-ages', ip: '203.0.113.7', userAgent: 'vitest' };
const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 8)
});

let database: TestDatabase;
let operator: AccessSubject;

beforeAll(async () => {
	database = await createTestDatabase();
	const user = await createUser(database.db);
	await database.db.insert(staffRoles).values({ userId: user.id, role: 'operator', grantedAt: new Date() });
	operator = {
		userId: user.id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
});

afterAll(async () => {
	await database.drop();
});

/** A candidate whose declared date the FSP import contradicted, as `fsp/sync.ts` leaves it. */
async function conflictCandidate(declared = '2000-03-15', visibility: 'hidden' | 'catalog' = 'hidden') {
	const user = await createUser(database.db, {
		emailEnc: Buffer.from(crypto.encrypt('ivan@example.org', 'users.email'))
	});
	const candidate = await createCandidate(database.db, {
		userId: user.id,
		birthDate: declared,
		lastNameEnc: Buffer.from(crypto.encrypt('Петров', 'candidates.last_name')),
		firstNameEnc: Buffer.from(crypto.encrypt('Иван', 'candidates.first_name')),
		visibility
	});
	await database.db.update(candidates).set({ birthDateStatus: 'conflict' }).where(eq(candidates.id, candidate.id));
	await database.db.insert(auditEvents).values({
		action: 'age.conflict',
		outcome: 'success',
		actorKind: 'system',
		subjectCandidateId: candidate.id,
		requestId: 'job:fsp.sync',
		details: { source: 'fsp_import' },
		occurredAt: new Date('2026-09-20T08:00:00Z')
	});
	return candidate;
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('expected a refusal');
}

async function candidateRow(id: string) {
	const [row] = await database.db.select().from(candidates).where(eq(candidates.id, id));
	if (!row) throw new Error('candidate is gone');
	return row;
}

/** The candidate's notifications of the decision, with the letter each would be. */
async function ageNotices(candidate: { id: string; userId: string }) {
	const rows = await database.db
		.select()
		.from(notifications)
		.where(and(eq(notifications.userId, candidate.userId), eq(notifications.type, 'candidate.age_verified')));
	return Promise.all(
		rows.map(async (row) => {
			if (!isNotificationType(row.type)) throw new Error(`unknown type ${row.type}`);
			const facts = await notificationFacts(database.db, crypto, { ...row, type: row.type });
			if (!facts) throw new Error('the candidate does not see the notification');
			const letter = notificationLetter('ivan@example.org', row.type, facts, row.payload as Record<string, unknown>, {
				open: `http://app.test/notifications/${row.id}`,
				settings: 'http://app.test/settings'
			});
			return { row, letter };
		})
	);
}

const bandOf = (row: Awaited<ReturnType<typeof candidateRow>>) =>
	ageBand({ birthDate: row.birthDate, precision: row.birthDatePrecision, status: row.birthDateStatus }, NOW);

describe('age conflicts', () => {
	it('refuses the queue, the case and the decision without the right', async () => {
		const candidate = await conflictCandidate();
		const admin: AccessSubject = { ...operator, staff: { operator: false, admin: true, extraPermissions: [] } };
		const self: AccessSubject = {
			...operator,
			userId: candidate.userId,
			candidate: { id: candidate.id, status: 'active' },
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		for (const subject of [admin, self]) {
			expect((await refusal(ageConflictQueue(database.db, subject))).code).toBe('forbidden');
			expect((await refusal(ageCase(database.db, crypto, subject, meta, candidate.id, NOW))).code).toBe('forbidden');
			const decision = resolveAgeConflict(
				database.db,
				subject,
				meta,
				candidate.id,
				{ birthDate: '2000-03-15', method: 'in_person', documentKind: 'passport' },
				NOW
			);
			expect((await refusal(decision)).code).toBe('forbidden');
		}
		expect((await candidateRow(candidate.id)).birthDateStatus).toBe('conflict');
	});

	it('lists the conflict and opens the case with the name and the address under the journal', async () => {
		const candidate = await conflictCandidate('2001-07-01');
		const queue = await ageConflictQueue(database.db, operator);
		const item = queue.find((entry) => entry.candidateId === candidate.id);
		expect(item).toEqual({
			candidateId: candidate.id,
			openedAt: new Date('2026-09-20T08:00:00Z'),
			declaredPrecision: 'day'
		});
		const opened = await ageCase(database.db, crypto, operator, meta, candidate.id, NOW);
		expect(opened).toMatchObject({
			status: 'conflict',
			person: { fullName: 'Петров Иван', email: 'ivan@example.org' },
			declared: { birthDate: '2001-07-01', precision: 'day', source: 'self_declared' }
		});
		const [access] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'operator.case_access'), eq(auditEvents.subjectCandidateId, candidate.id)));
		expect(access).toMatchObject({
			actorUserId: operator.userId,
			details: { case_type: 'age', case_id: candidate.id }
		});

		const other = await createCandidate(database.db);
		expect((await refusal(ageCase(database.db, crypto, operator, meta, other.id, NOW))).code).toBe('not_found');
	});

	it('verifies the date of the document, opens the adult regime and records the decision', async () => {
		const candidate = await conflictCandidate('2000-03-15');
		expect(bandOf(await candidateRow(candidate.id))).toBe('unknown');
		const outcome = await resolveAgeConflict(
			database.db,
			operator,
			meta,
			candidate.id,
			{ birthDate: '1999-11-02', method: 'document_presented', documentKind: 'passport' },
			NOW
		);
		expect(outcome).toEqual({ regime: 'adult', matchesDeclared: false, hidden: false });
		const row = await candidateRow(candidate.id);
		expect(row).toMatchObject({
			birthDate: '1999-11-02',
			birthDatePrecision: 'day',
			birthDateSource: 'operator_document',
			birthDateStatus: 'verified',
			birthDateVerifiedBy: operator.userId,
			profileRevision: candidate.profileRevision + 1
		});
		expect(bandOf(row)).toBe('adult');
		await expect(ageConflictQueue(database.db, operator)).resolves.not.toContainEqual(
			expect.objectContaining({ candidateId: candidate.id })
		);
		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'age.verified'), eq(auditEvents.subjectCandidateId, candidate.id)));
		expect(event).toMatchObject({
			actorUserId: operator.userId,
			objectType: 'candidate',
			objectId: candidate.id,
			details: { method: 'document_presented', document_kind: 'passport', matches_declared: false, regime: 'adult' }
		});
		expect(JSON.stringify(event?.details)).not.toContain('1999');
		// The candidate learns the regime, never the date or the document.
		const [notice, ...more] = await ageNotices(candidate);
		expect(more).toEqual([]);
		expect(notice?.row).toMatchObject({
			category: 'account',
			objectType: 'candidate',
			objectId: candidate.id,
			payload: { regime: 'adult', hidden: false }
		});
		expect(notice?.letter.text).toContain('профиль ведётся как профиль совершеннолетнего');
		expect(notice?.letter.text).not.toMatch(/1999|02\.11|паспорт/u);
		if (!notice) throw new Error('no notification');
		expect(await openNotification(database.db, candidate.userId, notice.row.id, NOW)).toMatchObject({
			target: { kind: 'candidate_consents' }
		});
		const refresh = await database.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.type, 'match.refresh'), eq(jobs.dedupKey, `match:candidate:${candidate.id}`)));
		expect(refresh.length).toBeGreaterThan(0);

		const again = resolveAgeConflict(
			database.db,
			operator,
			meta,
			candidate.id,
			{ birthDate: '1999-11-02', method: 'in_person', documentKind: 'passport' },
			NOW
		);
		const error = await refusal(again);
		expect(error.code).toBe('conflict');
		expect(error.details?.[0]?.code).toBe('not_in_conflict');
	});

	it('puts a minor into the protected regime and takes the profile out of the catalog', async () => {
		const candidate = await conflictCandidate('2000-03-15', 'catalog');
		const outcome = await resolveAgeConflict(
			database.db,
			operator,
			meta,
			candidate.id,
			{ birthDate: '2010-01-20', method: 'in_person', documentKind: 'birth_certificate' },
			NOW
		);
		expect(outcome).toEqual({ regime: 'minor', matchesDeclared: false, hidden: true });
		const row = await candidateRow(candidate.id);
		expect(bandOf(row)).toBe(16);
		expect(row.visibility).toBe('hidden');
		const [notice] = await ageNotices(candidate);
		expect(notice?.row.payload).toEqual({ regime: 'minor', hidden: true });
		expect(notice?.letter.text).toContain('защищённом режиме');
		expect(notice?.letter.text).toContain('не показывается работодателям');
	});

	it('refuses an age at which no profile is kept and leaves the conflict open', async () => {
		const candidate = await conflictCandidate();
		const error = await refusal(
			resolveAgeConflict(
				database.db,
				operator,
				meta,
				candidate.id,
				{ birthDate: '2014-05-05', method: 'in_person', documentKind: 'birth_certificate' },
				NOW
			)
		);
		expect(error.code).toBe('conflict');
		expect(error.details?.[0]?.code).toBe('ineligible_age');
		const row = await candidateRow(candidate.id);
		expect(row).toMatchObject({ birthDate: '2000-03-15', birthDateStatus: 'conflict', birthDateVerifiedAt: null });
		const events = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'age.verified'), eq(auditEvents.subjectCandidateId, candidate.id)));
		expect(events).toHaveLength(0);
		expect(await ageNotices(candidate)).toEqual([]);
	});

	it('refuses a date that is not a real past date and an unknown document', async () => {
		const candidate = await conflictCandidate();
		const error = await refusal(
			resolveAgeConflict(
				database.db,
				operator,
				meta,
				candidate.id,
				{
					birthDate: '2031-02-30',
					method: 'in_person',
					documentKind: 'driving_licence' as unknown as 'passport'
				},
				NOW
			)
		);
		expect(error.code).toBe('validation_failed');
		expect((error.details ?? []).map((detail) => detail.path).sort()).toEqual(['birthDate', 'documentKind']);
	});

	it('counts the open conflicts on the first screen of the cabinet, as the queue lists them', async () => {
		await conflictCandidate();
		const queue = await ageConflictQueue(database.db, operator);
		expect(queue.length).toBeGreaterThan(0);
		expect(await ageConflictCount(database.db, operator)).toBe(queue.length);
		expect((await operatorOverview(database.db, operator, NOW)).ages).toEqual({ open: queue.length });
		const admin: AccessSubject = { ...operator, staff: { operator: false, admin: true, extraPermissions: [] } };
		expect((await refusal(ageConflictCount(database.db, admin))).code).toBe('forbidden');
	});
});
