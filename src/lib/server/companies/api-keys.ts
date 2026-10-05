// API keys of a company (domain 5.4, contracts 5.2): `Authorization: Bearer fspk_<prefix>_<secret>`. Only the SHA-256
// of the secret is stored and the key is shown once. A key acts on behalf of its creator's membership: every request
// checks revocation, expiry, the membership and the status of the company.
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { Actor } from '$lib/server/access/actor';
import { companyAdmission, PERMISSIONS, rolesOf, type Permission } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { newSecret, secretsEqual, sha256Hex } from '$lib/server/auth/secrets';
import { base32 } from '$lib/server/crypto/encoding';
import type { Executor } from '$lib/server/db';
import { apiKeys, companies, companyMembers } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import {
	auditActorOf,
	invalid,
	requirePermission,
	sessionUserId,
	type ActionContext,
	type CompanyDeps
} from './context';
import { admissionRefusal } from './gate';
import { lockCompany } from './rows';

const TOKEN_PATTERN = /^fspk_([a-z2-7]{8})_([A-Za-z0-9_-]{43})$/;

/** `last_used_at` is written at most once per this interval: a key used in a loop does not write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

const NAME_MAX = 100;

export interface ApiKeySummary {
	id: string;
	name: string;
	prefix: string;
	permissions: Permission[];
	createdByMemberId: string;
	createdAt: Date;
	expiresAt: Date | null;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

function isPermission(value: string): value is Permission {
	return Object.hasOwn(PERMISSIONS, value);
}

/**
 * Creates a key of a verified company. Its permissions are a subset of the creator's: each is allowed for keys and
 * held by a role the creator has now. The returned `token` is the only time the secret leaves the server.
 */
export async function createApiKey(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string,
	input: { name: string; permissions: string[]; expiresAt: Date | null }
): Promise<{ key: ApiKeySummary; token: string }> {
	requirePermission(ctx.subject, 'api_key.manage', { companyId });
	sessionUserId(ctx.subject);
	const creator = ctx.subject.membership;
	if (creator === null) throw new Error('a key manager has no membership');
	const name = input.name.trim();
	const now = deps.now();
	const roles = rolesOf(ctx.subject);
	const permissions = [...new Set(input.permissions)];
	const problems: ErrorDetail[] = [];
	if (name.length < 1 || name.length > NAME_MAX) {
		problems.push({ path: 'name', code: 'invalid_length', message: `Название ключа — от 1 до ${NAME_MAX} символов` });
	}
	if (permissions.length === 0) {
		problems.push({ path: 'permissions', code: 'required', message: 'Выберите хотя бы одно право ключа' });
	}
	for (const permission of permissions) {
		const allowed =
			isPermission(permission) &&
			PERMISSIONS[permission].apiKey &&
			PERMISSIONS[permission].roles.some((role) => roles.has(role));
		if (!allowed) {
			problems.push({ path: 'permissions', code: 'not_grantable', message: `Право ${permission} нельзя выдать ключу` });
		}
	}
	if (input.expiresAt !== null && input.expiresAt.getTime() <= now.getTime()) {
		problems.push({ path: 'expiresAt', code: 'in_past', message: 'Срок действия должен быть в будущем' });
	}
	if (problems.length > 0) throw invalid(problems);

	const prefix = base32(randomBytes(5));
	const secret = newSecret();
	const created = await deps.db.transaction(async (tx) => {
		const company = await lockCompany(tx, companyId);
		const admission = companyAdmission(company.status);
		if (!admission.admitted) throw admissionRefusal(admission.reason);
		const [key] = await tx
			.insert(apiKeys)
			.values({
				companyId,
				createdByMemberId: creator.memberId,
				name,
				prefix,
				secretHash: sha256Hex(secret),
				permissions,
				expiresAt: input.expiresAt
			})
			.returning();
		if (!key) throw new Error('api key not inserted');
		await recordAuditEvent(tx, {
			actor: auditActorOf(ctx.subject),
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			action: 'api_key.created',
			outcome: 'success',
			object: { type: 'api_key', id: key.id },
			details: { company_id: companyId, prefix, permissions }
		});
		return key;
	});
	return { key: summary(created), token: `fspk_${prefix}_${secret}` };
}

function summary(row: typeof apiKeys.$inferSelect): ApiKeySummary {
	return {
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		permissions: row.permissions.filter(isPermission),
		createdByMemberId: row.createdByMemberId,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		lastUsedAt: row.lastUsedAt,
		revokedAt: row.revokedAt
	};
}

/** Keys of the company without their hashes, newest first. */
export async function listApiKeys(deps: CompanyDeps, ctx: ActionContext, companyId: string): Promise<ApiKeySummary[]> {
	requirePermission(ctx.subject, 'api_key.manage', { companyId });
	const rows = await deps.db
		.select()
		.from(apiKeys)
		.where(eq(apiKeys.companyId, companyId))
		.orderBy(desc(apiKeys.createdAt));
	return rows.map(summary);
}

/** Revokes a key; revoking a revoked key changes nothing. */
export async function revokeApiKey(deps: CompanyDeps, ctx: ActionContext, keyId: string): Promise<void> {
	sessionUserId(ctx.subject);
	const now = deps.now();
	await deps.db.transaction(async (tx) => {
		const [key] = await tx
			.select({ companyId: apiKeys.companyId, revokedAt: apiKeys.revokedAt })
			.from(apiKeys)
			.where(eq(apiKeys.id, keyId))
			.for('update');
		if (!key) throw new ApiError('not_found');
		requirePermission(ctx.subject, 'api_key.manage', { companyId: key.companyId });
		if (key.revokedAt !== null) return;
		await tx.update(apiKeys).set({ revokedAt: now }).where(eq(apiKeys.id, keyId));
		await recordAuditEvent(tx, {
			actor: auditActorOf(ctx.subject),
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			action: 'api_key.revoked',
			outcome: 'success',
			object: { type: 'api_key', id: keyId },
			details: { company_id: key.companyId, reason: 'manual' }
		});
	});
}

export type ApiKeyActor = Extract<Actor, { kind: 'api_key' }>;

/**
 * Resolves a bearer token to the actor of its key, or `null` — malformed, unknown, revoked, expired, or its creator is
 * no longer an active member of a verified company. The caller answers `401` for `null` without saying which.
 */
export async function authenticateApiKey(executor: Executor, token: string, now: Date): Promise<ApiKeyActor | null> {
	const match = TOKEN_PATTERN.exec(token);
	if (!match) return null;
	const [, prefix = '', secret = ''] = match;
	const [row] = await executor
		.select({
			id: apiKeys.id,
			companyId: apiKeys.companyId,
			memberId: apiKeys.createdByMemberId,
			secretHash: apiKeys.secretHash,
			permissions: apiKeys.permissions,
			expiresAt: apiKeys.expiresAt,
			revokedAt: apiKeys.revokedAt,
			memberStatus: companyMembers.status,
			memberCompanyId: companyMembers.companyId,
			userId: companyMembers.userId,
			companyStatus: companies.status
		})
		.from(apiKeys)
		.innerJoin(companyMembers, eq(companyMembers.id, apiKeys.createdByMemberId))
		.innerJoin(companies, eq(companies.id, apiKeys.companyId))
		.where(eq(apiKeys.prefix, prefix));
	if (!row || !secretsEqual(row.secretHash, sha256Hex(secret))) return null;
	if (row.revokedAt !== null) return null;
	if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;
	if (row.memberStatus !== 'active' || row.memberCompanyId !== row.companyId || row.userId === null) return null;
	// The admission policy closes the keys of a suspended or rejected company at once (domain 5.1).
	if (!companyAdmission(row.companyStatus).admitted) return null;
	await executor
		.update(apiKeys)
		.set({ lastUsedAt: now })
		.where(
			and(
				eq(apiKeys.id, row.id),
				or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)))
			)
		);
	return {
		kind: 'api_key',
		apiKeyId: row.id,
		companyId: row.companyId,
		memberId: row.memberId,
		userId: row.userId,
		// A permission removed from the registry after the key was created is not granted: the key narrows, never widens.
		permissions: row.permissions.filter(isPermission)
	};
}
