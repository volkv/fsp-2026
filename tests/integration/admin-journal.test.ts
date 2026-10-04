// Reading the action journal: only with `audit.read` (an administrator by the role, an operator by a grant), filtered
// by event, actor and object, a page at a time, and every reading is itself journaled with its filters.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { JOURNAL_PAGE_SIZE, parseJournalFilters, readJournal } from '$lib/server/admin/audit';
import { recordAuditEvent } from '$lib/server/audit/record';
import { auditEvents } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createUser } from '../helpers/factories';

let database: TestDatabase;
let meta: { requestId: string; ip: string; userAgent: string };
/** The reader is an account of the stand: the journal is read within the reach of the reader's account. */
let readerId: string;
const actorId = randomUUID();

const subject = (staff: Partial<AccessSubject['staff']>): AccessSubject => ({
	userId: readerId,
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: false, admin: false, extraPermissions: [], ...staff }
});

const auditor = () => ({ subject: subject({ operator: true, extraPermissions: ['audit.read'] }), meta });
const filters = (query: Record<string, string>) => parseJournalFilters(new URLSearchParams(query));

async function readings() {
	return database.db
		.select()
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'audit.read'), eq(auditEvents.requestId, meta.requestId)));
}

beforeAll(async () => {
	database = await createTestDatabase();
	readerId = (await createUser(database.db)).id;
	const base = Date.now() - 3_600_000;
	for (let index = 0; index < JOURNAL_PAGE_SIZE + 5; index++) {
		await recordAuditEvent(database.db, {
			action: 'ml.mode_changed',
			outcome: 'success',
			actor: { kind: 'user', userId: actorId },
			object: { type: 'model_operation', id: 'extract' },
			requestId: `seed-${index}`,
			ip: '10.0.0.1',
			userAgent: 'seed',
			details: { operation: 'extract', from: index % 2 ? 'on' : 'off', to: index % 2 ? 'off' : 'on' },
			occurredAt: new Date(base + index * 1_000)
		});
	}
	await recordAuditEvent(database.db, {
		action: 'staff.role_granted',
		outcome: 'success',
		actor: { kind: 'user', userId: randomUUID() },
		object: { type: 'user', id: actorId },
		requestId: 'seed-grant',
		details: { role: 'operator' }
	});
});

afterAll(async () => {
	await database.drop();
});

beforeEach(() => {
	meta = { requestId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' };
});

describe('reading the journal', () => {
	it('is refused to an operator without the grant and to a person without a staff role, and nothing is recorded as read', async () => {
		await expect(
			readJournal(database.db, { subject: subject({ operator: true }), meta }, filters({}))
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(readJournal(database.db, { subject: subject({}), meta }, filters({}))).rejects.toMatchObject({
			code: 'forbidden'
		});
		expect(await readings()).toEqual([]);
	});

	it('gives an administrator by the role exactly what an operator with the grant reads, and journals the reading', async () => {
		const query = { action: 'ml.mode_changed', actor: actorId };
		const byAdmin = await readJournal(database.db, { subject: subject({ admin: true }), meta }, filters(query));
		const byOperator = await readJournal(database.db, auditor(), filters(query));
		expect(byAdmin).toEqual(byOperator);
		// The same fields for both: identifiers and codes, no address or browser of the actor.
		expect(Object.keys(byAdmin.entries[0] ?? {}).sort()).toEqual(
			[
				'id',
				'occurredAt',
				'action',
				'outcome',
				'actorKind',
				'actorUserId',
				'actorCompanyId',
				'apiKeyId',
				'objectType',
				'objectId',
				'subjectCandidateId',
				'requestId',
				'details'
			].sort()
		);
		const recorded = await readings();
		expect(recorded).toHaveLength(2);
		expect(recorded.every((row) => row.actorUserId === readerId && row.outcome === 'success')).toBe(true);
	});

	it('filters by event and actor, pages by a cursor, and journals each reading with its filters', async () => {
		const first = await readJournal(database.db, auditor(), filters({ action: 'ml.mode_changed', actor: actorId }));
		expect(first.entries).toHaveLength(JOURNAL_PAGE_SIZE);
		expect(first.entries.every((entry) => entry.action === 'ml.mode_changed')).toBe(true);
		// Addresses and browsers stay in the journal and are not read out.
		expect(Object.keys(first.entries[0] ?? {})).not.toContain('ip');
		expect(first.nextCursor).not.toBeNull();
		const second = await readJournal(
			database.db,
			auditor(),
			filters({ action: 'ml.mode_changed', actor: actorId, cursor: first.nextCursor ?? '' })
		);
		expect(second.entries).toHaveLength(5);
		expect(second.nextCursor).toBeNull();
		const seen = new Set([...first.entries, ...second.entries].map((entry) => entry.requestId));
		expect(seen.size).toBe(JOURNAL_PAGE_SIZE + 5);

		const recorded = await readings();
		expect(recorded).toHaveLength(2);
		expect(recorded.map((row) => row.details)).toContainEqual({
			result_count: JOURNAL_PAGE_SIZE,
			action: 'ml.mode_changed',
			actor_user_id: actorId
		});
		expect(recorded[0]).toMatchObject({ actorUserId: readerId, outcome: 'success' });
	});

	it('filters by object', async () => {
		const page = await readJournal(database.db, auditor(), filters({ objectType: 'user', objectId: actorId }));
		expect(page.entries.map((entry) => entry.requestId)).toEqual(['seed-grant']);
	});

	it('names each filter that cannot be one instead of ignoring it', () => {
		let refusal: unknown;
		try {
			filters({ action: 'no.such_event', actor: 'x', from: '2026-13-01', objectId: 'a b' });
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(ApiError);
		const { code, details } = refusal as ApiError;
		expect(code).toBe('validation_failed');
		expect(details?.map((detail) => detail.path)).toEqual(['action', 'actor', 'objectId', 'from']);
	});
});
