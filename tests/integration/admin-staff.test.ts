// Staff roles from the administrator cabinet: a person is found by the keyed hash of the exact address, roles are
// granted and revoked under `staff.manage`, every change is journaled in its transaction, and nobody changes their own.
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	findUser,
	grantStaffRole,
	revokeStaffRole,
	setOperatorAuditRead,
	staffList,
	type StaffDeps
} from '$lib/server/admin/staff';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { auditEvents, staffRoles, users } from '$lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser } from '../helpers/factories';

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

let database: TestDatabase;
let deps: StaffDeps;
let adminId: string;
let meta: { requestId: string; ip: string; userAgent: string };

const subject = (userId: string, staff: Partial<AccessSubject['staff']>): AccessSubject => ({
	userId,
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: false, admin: false, extraPermissions: [], ...staff }
});

const admin = () => ({ subject: subject(adminId, { admin: true }), meta });

/** A person with a real encrypted address and its lookup hash, as registration stores them. */
async function person(email: string) {
	return createUser(database.db, {
		emailEnc: crypto.encrypt(email, 'users.email'),
		emailHmac: crypto.lookupHmac('email', email),
		displayName: 'Сотрудник ФСП'
	});
}

async function activeRoles(userId: string) {
	return database.db
		.select({ role: staffRoles.role, extra: staffRoles.extraPermissions, grantedBy: staffRoles.grantedBy })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, userId), isNull(staffRoles.revokedAt)));
}

async function journal() {
	return database.db
		.select()
		.from(auditEvents)
		.where(eq(auditEvents.requestId, meta.requestId))
		.orderBy(auditEvents.occurredAt);
}

beforeAll(async () => {
	database = await createTestDatabase();
	deps = { db: database.db, crypto, now: () => new Date() };
	adminId = (await person(`admin-${randomUUID()}@example.org`)).id;
	await database.db.insert(staffRoles).values({ userId: adminId, role: 'admin', grantedAt: new Date() });
});

afterAll(async () => {
	await database.drop();
});

beforeEach(() => {
	meta = { requestId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' };
});

describe('finding a user', () => {
	it('finds by the exact address through its lookup hash, whatever the case, and by the account id', async () => {
		const email = `Person-${randomUUID()}@Example.org`;
		const user = await person(email);
		await createCandidate(database.db, { userId: user.id });
		expect(await findUser(deps, admin(), `  ${email.toLowerCase()} `)).toMatchObject({
			id: user.id,
			isCandidate: true,
			membership: null,
			staff: [],
			isSelf: false
		});
		expect((await findUser(deps, admin(), user.id))?.id).toBe(user.id);
		expect(await findUser(deps, admin(), 'nobody@example.org')).toBeNull();
	});

	it('refuses a partial address instead of searching over encrypted addresses', async () => {
		await expect(findUser(deps, admin(), 'example.org')).rejects.toMatchObject({ code: 'validation_failed' });
	});

	it('is closed to anyone but an administrator', async () => {
		const operator = await person(`operator-${randomUUID()}@example.org`);
		await expect(
			findUser(deps, { subject: subject(operator.id, { operator: true }), meta }, operator.id)
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('staff roles', () => {
	it('grants an operator with the journal right, journaled in the same transaction', async () => {
		const user = await person(`grant-${randomUUID()}@example.org`);
		await grantStaffRole(deps, admin(), { userId: user.id, role: 'operator', auditRead: true });
		expect(await activeRoles(user.id)).toEqual([{ role: 'operator', extra: ['audit.read'], grantedBy: adminId }]);
		const [entry] = await journal();
		expect(entry).toMatchObject({
			action: 'staff.role_granted',
			actorUserId: adminId,
			objectType: 'user',
			objectId: user.id,
			details: { role: 'operator', extra_permissions: ['audit.read'] }
		});
		const listed = (await staffList(deps, admin())).find((member) => member.userId === user.id);
		expect(listed?.email).toMatch(/^grant-.*@example\.org$/);
	});

	it('refuses a grant without staff.manage: nothing is granted and nothing journaled', async () => {
		const user = await person(`denied-${randomUUID()}@example.org`);
		const operator = await person(`op-${randomUUID()}@example.org`);
		const ctx = { subject: subject(operator.id, { operator: true, extraPermissions: ['audit.read'] }), meta };
		await expect(grantStaffRole(deps, ctx, { userId: user.id, role: 'admin', auditRead: false })).rejects.toMatchObject(
			{ code: 'forbidden' }
		);
		await expect(revokeStaffRole(deps, ctx, { userId: adminId, role: 'admin' })).rejects.toMatchObject({
			code: 'forbidden'
		});
		expect(await activeRoles(user.id)).toEqual([]);
		expect(await activeRoles(adminId)).toHaveLength(1);
		expect(await journal()).toEqual([]);
	});

	it('refuses changes of your own roles, a second grant of the same role and a grant to an inactive account', async () => {
		await expect(
			grantStaffRole(deps, admin(), { userId: adminId, role: 'operator', auditRead: true })
		).rejects.toMatchObject({ code: 'conflict', details: [{ code: 'self_change' }] });
		await expect(revokeStaffRole(deps, admin(), { userId: adminId, role: 'admin' })).rejects.toMatchObject({
			code: 'conflict'
		});
		const user = await person(`twice-${randomUUID()}@example.org`);
		await grantStaffRole(deps, admin(), { userId: user.id, role: 'admin', auditRead: false });
		await expect(
			grantStaffRole(deps, admin(), { userId: user.id, role: 'admin', auditRead: false })
		).rejects.toMatchObject({ details: [{ code: 'already_granted' }] });
		const pending = await person(`pending-${randomUUID()}@example.org`);
		await database.db.update(users).set({ status: 'pending_email' }).where(eq(users.id, pending.id));
		await expect(
			grantStaffRole(deps, admin(), { userId: pending.id, role: 'operator', auditRead: false })
		).rejects.toMatchObject({ details: [{ code: 'user_not_active' }] });
		await expect(
			grantStaffRole(deps, admin(), { userId: randomUUID(), role: 'operator', auditRead: false })
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('revokes a role and replaces the operator grant when the journal right changes', async () => {
		const user = await person(`change-${randomUUID()}@example.org`);
		await grantStaffRole(deps, admin(), { userId: user.id, role: 'operator', auditRead: false });
		expect(await setOperatorAuditRead(deps, admin(), { userId: user.id, enabled: true })).toEqual({ changed: true });
		expect(await setOperatorAuditRead(deps, admin(), { userId: user.id, enabled: true })).toEqual({ changed: false });
		expect(await activeRoles(user.id)).toEqual([{ role: 'operator', extra: ['audit.read'], grantedBy: adminId }]);
		await revokeStaffRole(deps, admin(), { userId: user.id, role: 'operator' });
		expect(await activeRoles(user.id)).toEqual([]);
		// Events of one millisecond have no order in the journal: compared as a set.
		const entries = (await journal()).map((row) => [row.action, row.details]);
		expect(entries).toHaveLength(4);
		expect(entries).toEqual(
			expect.arrayContaining([
				['staff.role_granted', { role: 'operator', extra_permissions: [] }],
				['staff.role_revoked', { role: 'operator', reason: 'permissions_changed' }],
				['staff.role_granted', { role: 'operator', extra_permissions: ['audit.read'] }],
				['staff.role_revoked', { role: 'operator' }]
			])
		);
	});
});
