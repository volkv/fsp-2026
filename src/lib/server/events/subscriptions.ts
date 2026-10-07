// Subscriptions of a company to its outgoing events (docs/domain.md, section 5.7; contracts 12): the owner registers a
// webhook — an HTTPS address, the events, a signing secret shown once — or connects Huntflow with the company's token.
// The secret rotates with a day of overlap: the webhook is signed with both secrets meanwhile. The journal of deliveries
// shows every attempt. Subscriptions are managed in a browser session by the owner of an admitted company, never by a
// key: they hold secrets.
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { isIP } from 'node:net';
import { z } from 'zod';
import { recordAuditEvent } from '$lib/server/audit/record';
import {
	auditActorOf,
	invalid,
	requirePermission,
	sessionUserId,
	type ActionContext
} from '$lib/server/companies/context';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Transaction } from '$lib/server/db';
import {
	atsLinks,
	COMPANY_EVENT_TYPES,
	eventDeliveries,
	eventSubscriptions,
	type DELIVERY_STATUSES
} from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import { enqueueDelivery, type CompanyEventType } from './emit';
import { isBlockedAddress } from './http';
import { HUNTFLOW_EVENTS, huntflowSettingsSchema, type HuntflowSettings } from './huntflow';

/** The previous secret keeps signing for a day after a rotation: the receiver switches without losing events. */
export const ROTATION_OVERLAP_MS = 24 * 3600_000;
const DELIVERY_PAGE = 50;
const NAME_MAX = 100;
const URL_MAX = 500;

export interface SubscriptionDeps {
	db: Database;
	crypto: FieldCrypto;
	now: () => Date;
	/** `null` — the Huntflow adapter is off on this stand. */
	huntflowApiUrl: string | null;
}

type SubscriptionRow = typeof eventSubscriptions.$inferSelect;

export interface SubscriptionSummary {
	id: string;
	target: SubscriptionRow['target'];
	name: string;
	url: string | null;
	events: CompanyEventType[];
	status: SubscriptionRow['status'];
	/** The last characters of the secret or the token. */
	secretHint: string;
	/** Until when the previous secret still signs; `null` — no rotation in progress. */
	previousSecretUntil: Date | null;
	huntflow: HuntflowSettings | null;
	createdAt: Date;
}

export interface DeliveryView {
	id: string;
	eventId: string;
	eventType: string;
	status: (typeof DELIVERY_STATUSES)[number];
	attempts: number;
	lastStatus: number | null;
	lastError: string | null;
	occurredAt: Date;
	deliveredAt: Date | null;
}

const isEventType = (value: string): value is CompanyEventType =>
	(COMPANY_EVENT_TYPES as readonly string[]).includes(value);

function summary(row: SubscriptionRow): SubscriptionSummary {
	return {
		id: row.id,
		target: row.target,
		name: row.name,
		url: row.url,
		events: row.events.filter(isEventType),
		status: row.status,
		secretHint: row.secretHint,
		previousSecretUntil: row.previousSecretUntil,
		huntflow: row.target === 'huntflow' ? huntflowSettingsSchema.parse(row.settings) : null,
		createdAt: row.createdAt
	};
}

function newSigningSecret(): string {
	return `whsec_${randomBytes(32).toString('base64url')}`;
}

const hintOf = (secret: string) => `…${secret.slice(-4)}`;

function validName(problems: ErrorDetail[], value: string): string {
	const name = value.trim();
	if (name.length < 1 || name.length > NAME_MAX) {
		problems.push({ path: 'name', code: 'invalid_length', message: `Название — от 1 до ${NAME_MAX} символов` });
	}
	return name;
}

/** An HTTPS address outside private networks; a name is checked again on its resolved address when sending. */
function validUrl(problems: ErrorDetail[], value: string): string {
	const text = value.trim();
	const url = URL.canParse(text) ? new URL(text) : null;
	const host = url?.hostname.replace(/^\[|\]$/g, '').toLowerCase() ?? '';
	if (
		url === null ||
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		text.length > URL_MAX ||
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		(isIP(host) !== 0 && isBlockedAddress(host))
	) {
		problems.push({
			path: 'url',
			code: 'invalid_url',
			message: 'Адрес — https:// во внешней сети, без логина и пароля, до 500 символов'
		});
	}
	return text;
}

function validEvents(problems: ErrorDetail[], values: readonly string[]): CompanyEventType[] {
	const events = [...new Set(values)];
	if (events.length === 0 || !events.every(isEventType)) {
		problems.push({ path: 'events', code: 'invalid', message: 'Выберите события из списка' });
		return [];
	}
	return events.filter(isEventType);
}

function audit(ctx: ActionContext) {
	return {
		actor: auditActorOf(ctx.subject),
		requestId: ctx.meta.requestId,
		ip: ctx.meta.ip,
		userAgent: ctx.meta.userAgent,
		outcome: 'success' as const
	};
}

function creator(ctx: ActionContext, companyId: string): string {
	requirePermission(ctx.subject, 'company.events.manage', { companyId });
	sessionUserId(ctx.subject);
	const membership = ctx.subject.membership;
	if (membership === null) throw new Error('an events manager has no membership');
	return membership.memberId;
}

export async function listSubscriptions(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string
): Promise<SubscriptionSummary[]> {
	creator(ctx, companyId);
	const rows = await deps.db
		.select()
		.from(eventSubscriptions)
		.where(eq(eventSubscriptions.companyId, companyId))
		.orderBy(desc(eventSubscriptions.createdAt));
	return rows.map(summary);
}

/** A webhook: the secret is returned once and kept encrypted. */
export async function createWebhook(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string,
	input: { name: string; url: string; events: readonly string[] }
): Promise<{ subscription: SubscriptionSummary; secret: string }> {
	const memberId = creator(ctx, companyId);
	const problems: ErrorDetail[] = [];
	const name = validName(problems, input.name);
	const url = validUrl(problems, input.url);
	const events = validEvents(problems, input.events);
	if (problems.length > 0) throw invalid(problems);
	const secret = newSigningSecret();
	const row = await deps.db.transaction(async (tx) => {
		const [created] = await tx
			.insert(eventSubscriptions)
			.values({
				companyId,
				target: 'webhook',
				name,
				url,
				events,
				status: 'active',
				secretEnc: deps.crypto.encrypt(secret, 'event_subscriptions.secret'),
				secretHint: hintOf(secret),
				createdByMemberId: memberId
			})
			.returning();
		if (!created) throw new Error('subscription not inserted');
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'event_subscription.created',
			object: { type: 'event_subscription', id: created.id },
			details: { company_id: companyId, target: 'webhook', events }
		});
		return created;
	});
	return { subscription: summary(row), secret };
}

/** Huntflow with the company's token and its mapping of statuses; refused while the adapter is off. */
export async function connectHuntflow(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string,
	input: { name: string; token: string; settings: unknown }
): Promise<SubscriptionSummary> {
	const memberId = creator(ctx, companyId);
	if (deps.huntflowApiUrl === null) {
		throw new ApiError('conflict', {
			details: [{ code: 'huntflow_disabled', message: 'Интеграция с Хантфлоу на этом стенде не включена' }]
		});
	}
	const problems: ErrorDetail[] = [];
	const name = validName(problems, input.name);
	const token = input.token.trim();
	if (!/^[\x21-\x7e]{16,1024}$/.test(token)) {
		problems.push({ path: 'token', code: 'invalid', message: 'Вставьте токен API Хантфлоу целиком' });
	}
	const settings = huntflowSettingsSchema.safeParse(input.settings);
	if (!settings.success) {
		problems.push({
			path: 'settings',
			code: 'invalid',
			message: 'Укажите аккаунт, вакансию и статусы Хантфлоу числами'
		});
	}
	if (problems.length > 0 || !settings.success) throw invalid(problems);
	const row = await deps.db.transaction(async (tx) => {
		const [created] = await tx
			.insert(eventSubscriptions)
			.values({
				companyId,
				target: 'huntflow',
				name,
				events: [...HUNTFLOW_EVENTS],
				status: 'active',
				secretEnc: deps.crypto.encrypt(token, 'event_subscriptions.secret'),
				secretHint: hintOf(token),
				settings: settings.data,
				createdByMemberId: memberId
			})
			.returning();
		if (!created) throw new Error('subscription not inserted');
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'event_subscription.created',
			object: { type: 'event_subscription', id: created.id },
			details: { company_id: companyId, target: 'huntflow', events: [...HUNTFLOW_EVENTS] }
		});
		return created;
	});
	return summary(row);
}

/** The subscription of the company under a row lock, or `404`. */
async function lockSubscription(tx: Transaction, companyId: string, subscriptionId: string): Promise<SubscriptionRow> {
	if (!z.uuid().safeParse(subscriptionId).success) throw new ApiError('not_found');
	const [row] = await tx
		.select()
		.from(eventSubscriptions)
		.where(and(eq(eventSubscriptions.id, subscriptionId), eq(eventSubscriptions.companyId, companyId)))
		.for('update');
	if (!row) throw new ApiError('not_found');
	return row;
}

/** Name, address, events (of a webhook) and pause. */
export async function updateSubscription(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string,
	subscriptionId: string,
	patch: { name?: string; url?: string; events?: readonly string[]; status?: 'active' | 'paused' }
): Promise<SubscriptionSummary> {
	creator(ctx, companyId);
	return deps.db.transaction(async (tx) => {
		const row = await lockSubscription(tx, companyId, subscriptionId);
		const problems: ErrorDetail[] = [];
		const values: Partial<typeof eventSubscriptions.$inferInsert> = {};
		if (patch.name !== undefined) values.name = validName(problems, patch.name);
		if (patch.url !== undefined || patch.events !== undefined) {
			if (row.target !== 'webhook') {
				problems.push({ path: 'url', code: 'not_webhook', message: 'Адрес и события меняются только у вебхука' });
			} else {
				if (patch.url !== undefined) values.url = validUrl(problems, patch.url);
				if (patch.events !== undefined) values.events = validEvents(problems, patch.events);
			}
		}
		if (patch.status !== undefined) values.status = patch.status;
		if (problems.length > 0) throw invalid(problems);
		const [updated] = await tx
			.update(eventSubscriptions)
			.set(values)
			.where(eq(eventSubscriptions.id, row.id))
			.returning();
		if (!updated) throw new Error('subscription disappeared');
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'event_subscription.updated',
			object: { type: 'event_subscription', id: row.id },
			details: { company_id: companyId, fields: Object.keys(values) }
		});
		return summary(updated);
	});
}

/**
 * A new secret of a webhook, returned once; the previous one keeps signing for a day. For Huntflow the owner gives the
 * new token instead, and the old one is dropped at once.
 */
export async function rotateSecret(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string,
	subscriptionId: string,
	input: { token?: string } = {}
): Promise<{ subscription: SubscriptionSummary; secret: string | null }> {
	creator(ctx, companyId);
	return deps.db.transaction(async (tx) => {
		const row = await lockSubscription(tx, companyId, subscriptionId);
		const now = deps.now();
		let secret: string;
		let values: Partial<typeof eventSubscriptions.$inferInsert>;
		if (row.target === 'webhook') {
			secret = newSigningSecret();
			values = {
				previousSecretEnc: deps.crypto.encrypt(
					deps.crypto.decrypt(row.secretEnc, 'event_subscriptions.secret'),
					'event_subscriptions.previous_secret'
				),
				previousSecretUntil: new Date(now.getTime() + ROTATION_OVERLAP_MS)
			};
		} else {
			secret = (input.token ?? '').trim();
			if (!/^[\x21-\x7e]{16,1024}$/.test(secret)) {
				throw invalid([{ path: 'token', code: 'invalid', message: 'Вставьте новый токен API Хантфлоу целиком' }]);
			}
			values = {};
		}
		const [updated] = await tx
			.update(eventSubscriptions)
			.set({
				...values,
				secretEnc: deps.crypto.encrypt(secret, 'event_subscriptions.secret'),
				secretHint: hintOf(secret)
			})
			.where(eq(eventSubscriptions.id, row.id))
			.returning();
		if (!updated) throw new Error('subscription disappeared');
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'event_subscription.secret_rotated',
			object: { type: 'event_subscription', id: row.id },
			details: { company_id: companyId, target: row.target }
		});
		return { subscription: summary(updated), secret: row.target === 'webhook' ? secret : null };
	});
}

/** The subscription goes with its journal of deliveries and the records of its adapter. */
export async function deleteSubscription(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string,
	subscriptionId: string
): Promise<void> {
	creator(ctx, companyId);
	await deps.db.transaction(async (tx) => {
		const row = await lockSubscription(tx, companyId, subscriptionId);
		await tx.delete(eventDeliveries).where(eq(eventDeliveries.subscriptionId, row.id));
		await tx.delete(atsLinks).where(eq(atsLinks.subscriptionId, row.id));
		await tx.delete(eventSubscriptions).where(eq(eventSubscriptions.id, row.id));
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'event_subscription.deleted',
			object: { type: 'event_subscription', id: row.id },
			details: { company_id: companyId, target: row.target }
		});
	});
}

/** A `ping` to the subscription: the owner checks the address and the signature without waiting for an event. */
export async function sendPing(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string,
	subscriptionId: string
): Promise<string> {
	creator(ctx, companyId);
	return deps.db.transaction(async (tx) => {
		const row = await lockSubscription(tx, companyId, subscriptionId);
		return enqueueDelivery(tx, {
			subscriptionId: row.id,
			companyId,
			eventId: uuidv7(),
			eventType: 'ping',
			invitationId: null,
			payload: { subscription_id: row.id },
			occurredAt: deps.now()
		});
	});
}

/** The latest deliveries of the subscription, newest first. */
export async function listDeliveries(
	deps: SubscriptionDeps,
	ctx: ActionContext,
	companyId: string,
	subscriptionId: string
): Promise<DeliveryView[]> {
	creator(ctx, companyId);
	if (!z.uuid().safeParse(subscriptionId).success) throw new ApiError('not_found');
	const [owned] = await deps.db
		.select({ id: eventSubscriptions.id })
		.from(eventSubscriptions)
		.where(and(eq(eventSubscriptions.id, subscriptionId), eq(eventSubscriptions.companyId, companyId)));
	if (!owned) throw new ApiError('not_found');
	return deps.db
		.select({
			id: eventDeliveries.id,
			eventId: eventDeliveries.eventId,
			eventType: eventDeliveries.eventType,
			status: eventDeliveries.status,
			attempts: eventDeliveries.attempts,
			lastStatus: eventDeliveries.lastStatus,
			lastError: eventDeliveries.lastError,
			occurredAt: eventDeliveries.occurredAt,
			deliveredAt: eventDeliveries.deliveredAt
		})
		.from(eventDeliveries)
		.where(eq(eventDeliveries.subscriptionId, subscriptionId))
		.orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id))
		.limit(DELIVERY_PAGE);
}
