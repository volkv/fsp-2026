// The online watch of leaks against the database (docs/domain.md, 10.5): the administrator quarantines a family only
// when the release still serves every history of the policy without it; a quarantined family is not served to attempts
// started after the quarantine, an attempt started before goes on to its decision; lifting puts the family back; both
// actions are journalled. A wrong answer that is the right answer of another candidate's instance of the family lands in
// the journal of signals of the attempt. The bank is the fixture bank (tests/helpers/families.ts): Frontend with a spare
// family-level per block and grade, Backend with the fewest the capacity check accepts.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { ItemInstance } from '$lib/server/assessments/contract/bank';
import type { SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { answerItem, startAttempt, type EngineDeps } from '$lib/server/assessments/engine';
import { liftQuarantine, quarantinedAt, quarantineFamily } from '$lib/server/assessments/quarantine';
import { slotsOf } from '$lib/server/assessments/select';
import { parseSignalLog } from '$lib/server/assessments/signals';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { auditEvents, bankFamilyQuarantines, productPolicies, testAttempts, testItems } from '$lib/server/db/schema';
import { declareGrade, insertAttempt, releaseFixtureBank, type FixtureBank } from '../helpers/bank';
import { attemptRunner, FakeSandbox } from '../helpers/attempts';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser } from '../helpers/factories';

let database: TestDatabase;
const banks = new Map<SpecializationKey, FixtureBank>();
const sandbox = new FakeSandbox();
const meta = { requestId: 'bank-leak', ip: null, userAgent: null };

function deps(_standing: unknown, specialization: SpecializationKey): EngineDeps {
	const bank = banks.get(specialization);
	if (!bank) throw new Error(`no fixture bank of ${specialization}`);
	return { standing: OWNER_STANDING, modules: bank.modules };
}

const { takeAttempt } = attemptRunner({ db: () => database.db, sandbox, deps, requestId: 'bank-leak' });

async function candidateSubject(): Promise<AccessSubject & { candidate: { id: string; status: 'active' } }> {
	const candidate = await createCandidate(database.db);
	await declareGrade(database.db, candidate.id, 'frontend', 'junior');
	return {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

async function adminSubject(): Promise<AccessSubject> {
	const user = await createUser(database.db);
	return {
		userId: user.id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: false, admin: true, extraPermissions: [] }
	};
}

const start = (subject: AccessSubject) =>
	startAttempt(
		database.db,
		deps(null, 'frontend'),
		subject,
		{ specialization: 'frontend', grade: 'junior' },
		{ now: new Date(), requestId: 'bank-leak' }
	);

const familiesOf = (attemptId: string) =>
	database.db
		.select({ family: testItems.familyKey })
		.from(testItems)
		.where(eq(testItems.attemptId, attemptId))
		.then((rows) => rows.map((r) => r.family));

beforeAll(async () => {
	database = await createTestDatabase();
	await database.db.insert(productPolicies).values({
		kind: 'assessment_policy',
		version: 1,
		params: { artifact_retention_days: 1 },
		effectiveFrom: new Date('2026-01-01T00:00:00Z')
	});
	banks.set('frontend', await releaseFixtureBank(database.db, 'frontend', { spare: 1 }));
	banks.set('backend', await releaseFixtureBank(database.db, 'backend'));
});

afterAll(async () => {
	await database.drop();
});

describe('quarantine of a family', () => {
	it('is refused, with the shortages named, when the release cannot serve the policy without the family', async () => {
		const admin = await adminSubject();
		const family = banks.get('backend')?.families[0]?.descriptor.key ?? '';
		await expect(
			quarantineFamily(
				database.db,
				admin,
				meta,
				{ specialization: 'backend', familyKey: family, reason: 'published', note: null },
				new Date()
			)
		).rejects.toMatchObject({
			code: 'conflict',
			details: [expect.objectContaining({ code: 'bank_capacity_exhausted' })]
		});
		expect(await quarantinedAt(database.db, 'backend', new Date())).toEqual(new Set());
	});

	it('keeps the family from attempts started after it; an attempt started before goes on; lifting puts it back', async () => {
		const admin = await adminSubject();
		// The family the first slot of Frontend Junior draws from first: the nearest to the informative Angoff, by key.
		const block = slotsOf('frontend', 'junior')[0]?.block;
		const family = (banks.get('frontend')?.families ?? [])
			.map((f) => f.descriptor)
			.filter((d) => d.block === block && d.levels.some((l) => l.grade === 'junior'))
			.map((d) => d.key)
			.sort()[0];
		if (family === undefined) throw new Error('no family of the first slot');

		const before = await candidateSubject();
		const { attempt: running } = await start(before);
		await quarantineFamily(
			database.db,
			admin,
			meta,
			{ specialization: 'frontend', familyKey: family, reason: 'solve_rate_signal', note: 'доля верных 0,9' },
			new Date()
		);
		const [journalled] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'bank.family_quarantined'), eq(auditEvents.objectId, `frontend/${family}`)));
		expect(journalled?.details).toMatchObject({ reason: 'solve_rate_signal' });
		await expect(
			quarantineFamily(
				database.db,
				admin,
				meta,
				{ specialization: 'frontend', familyKey: family, reason: 'other', note: null },
				new Date()
			)
		).rejects.toMatchObject({ details: [expect.objectContaining({ code: 'already_quarantined' })] });

		for (let i = 0; i < 4; i += 1) {
			const subject = await candidateSubject();
			const { attempt } = await start(subject);
			const state = await takeAttempt(subject, attempt.id, OWNER_STANDING, 'frontend', { correct: true });
			expect(state.status).toBe('decided');
			expect(await familiesOf(attempt.id)).not.toContain(family);
		}
		const state = await takeAttempt(before, running.id, OWNER_STANDING, 'frontend', { correct: true });
		expect(state.status).toBe('decided');

		await liftQuarantine(database.db, admin, meta, { specialization: 'frontend', familyKey: family }, new Date());
		expect(await quarantinedAt(database.db, 'frontend', new Date())).toEqual(new Set());
		const [row] = await database.db
			.select()
			.from(bankFamilyQuarantines)
			.where(eq(bankFamilyQuarantines.familyKey, family));
		expect(row?.liftedAt).not.toBeNull();
		const restored = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'bank.family_restored'), eq(auditEvents.objectId, `frontend/${family}`)));
		expect(restored).toHaveLength(1);
	});
});

describe('the answer of another instance', () => {
	it('is written into the journal of signals when a wrong answer is the key of another candidate’s instance', async () => {
		const subject = await candidateSubject();
		const { attempt, outcome } = await start(subject);
		if (outcome.kind !== 'next') throw new Error('the first slot was not served');
		const own = outcome.item;
		const ownKey = (own.instance as ItemInstance).answer;
		if (ownKey?.kind !== 'exact') throw new Error('the first slot is not a computed item');

		// Another candidate was served an instance of the same family and class with other parameters.
		const other = await createCandidate(database.db);
		const foreignAttempt = await insertAttempt(database.db, {
			candidateId: other.id,
			releaseId: banks.get('frontend')?.releaseId ?? '',
			status: 'expired'
		});
		const module = banks.get('frontend')?.families.find((f) => f.descriptor.key === own.familyKey)?.module;
		if (!module) throw new Error('no generator of the family');
		const seed = ['other-1', 'other-2', 'other-3']
			.map((s) => module.generate({ seed: s, grade: 'junior', classId: own.classId }))
			.find((i) => i.answer?.kind === 'exact' && i.answer.value !== ownKey.value);
		if (!seed?.answer || seed.answer.kind !== 'exact') throw new Error('no instance with another answer');
		await database.db.insert(testItems).values({
			attemptId: foreignAttempt.id,
			seq: 1,
			block: own.block,
			format: own.format,
			practice: false,
			familyKey: own.familyKey,
			familyVersion: own.familyVersion,
			classId: own.classId,
			instanceSeed: seed.seed,
			instance: seed,
			angoff: own.angoff,
			servedAt: new Date(Date.now() - 60_000),
			status: 'served'
		});

		const result = await answerItem(
			database.db,
			deps(null, 'frontend'),
			subject,
			{ attemptId: attempt.id, seq: 1, payload: { kind: 'answer', answer: seed.answer.value }, signals: null },
			{ now: new Date(), requestId: 'bank-leak' }
		);
		const journal = async () => {
			const [row] = await database.db
				.select({ signals: testAttempts.integritySignals })
				.from(testAttempts)
				.where(eq(testAttempts.id, attempt.id));
			return parseSignalLog(row?.signals ?? null).entries;
		};
		const [first] = await journal();
		expect(first?.foreignAnswer).toEqual({ classId: own.classId, sameClass: true });
		const [scored] = await database.db.select().from(testItems).where(eq(testItems.id, own.id));
		expect(scored?.score).toBe(0);

		// A wrong answer that is nobody's key is only a wrong answer.
		if (result.outcome.kind !== 'next') throw new Error('the second slot was not served');
		const next = result.outcome.item;
		const nextKey = (next.instance as ItemInstance).answer;
		if (nextKey?.kind !== 'exact') throw new Error('the second slot is not a computed item');
		await answerItem(
			database.db,
			deps(null, 'frontend'),
			subject,
			{ attemptId: attempt.id, seq: 2, payload: { kind: 'answer', answer: `${nextKey.value}0` }, signals: null },
			{ now: new Date(), requestId: 'bank-leak' }
		);
		const entries = await journal();
		expect(entries).toHaveLength(2);
		expect(entries[1]?.foreignAnswer).toBeUndefined();
	});
});
