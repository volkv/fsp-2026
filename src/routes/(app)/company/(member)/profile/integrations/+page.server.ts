import type { RequestEvent } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import type { ActionContext } from '$lib/server/companies/context';
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { COMPANY_EVENT_TYPES } from '$lib/server/db/schema';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import {
	connectHuntflow,
	createWebhook,
	deleteSubscription,
	listDeliveries,
	listSubscriptions,
	rotateSecret,
	sendPing,
	updateSubscription,
	type SubscriptionDeps
} from '$lib/server/events/subscriptions';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

const deps = (): SubscriptionDeps => ({
	db: db(),
	crypto: fieldCrypto(),
	now: () => new Date(),
	huntflowApiUrl: config().huntflowApiUrl
});

/** A positive integer of the form, or `undefined` for an empty field; anything else fails the settings check. */
function numberOf(form: FormData, name: string): number | undefined {
	const text = formText(form, name).trim();
	return text === '' ? undefined : Number(text);
}

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const ctx = { subject, meta };
	try {
		const subscriptions = await listSubscriptions(deps(), ctx, membership.companyId);
		const withDeliveries = [];
		for (const subscription of subscriptions) {
			const deliveries = await listDeliveries(deps(), ctx, membership.companyId, subscription.id);
			withDeliveries.push({ ...subscription, deliveries: deliveries.slice(0, 10) });
		}
		return {
			subscriptions: withDeliveries,
			eventTypes: [...COMPANY_EVENT_TYPES],
			huntflowEnabled: config().huntflowApiUrl !== null
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

async function act<T>(
	event: RequestEvent,
	run: (ctx: ActionContext, companyId: string, form: FormData) => Promise<T>
): Promise<T> {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const form = await event.request.formData();
	return run({ subject, meta }, membership.companyId, form);
}

export const actions: Actions = {
	webhook: async (event) => {
		try {
			return await act(event, async (ctx, companyId, form) => {
				const created = await createWebhook(deps(), ctx, companyId, {
					name: formText(form, 'name'),
					url: formText(form, 'url'),
					events: form.getAll('events').filter((value): value is string => typeof value === 'string')
				});
				// The secret is shown once, in this answer only.
				return { secret: { name: created.subscription.name, value: created.secret } };
			});
		} catch (cause) {
			return formFailure(cause);
		}
	},
	huntflow: async (event) => {
		try {
			return await act(event, async (ctx, companyId, form) => {
				await connectHuntflow(deps(), ctx, companyId, {
					name: formText(form, 'name'),
					token: formText(form, 'token'),
					settings: {
						account_id: numberOf(form, 'account_id'),
						vacancy_id: numberOf(form, 'vacancy_id'),
						statuses: Object.fromEntries(
							[
								'accepted',
								'interview_scheduled',
								'interview_done',
								'offer_made',
								'offer_accepted',
								'hired',
								'not_hired'
							].flatMap((key) => {
								const value = numberOf(form, `status_${key}`);
								return value === undefined ? [] : [[key, value]];
							})
						)
					}
				});
				return { connected: true };
			});
		} catch (cause) {
			return formFailure(cause);
		}
	},
	toggle: async (event) => {
		try {
			return await act(event, async (ctx, companyId, form) => {
				await updateSubscription(deps(), ctx, companyId, formText(form, 'subscriptionId'), {
					status: formText(form, 'status') === 'paused' ? 'paused' : 'active'
				});
				return { toggled: true };
			});
		} catch (cause) {
			return formFailure(cause);
		}
	},
	rotate: async (event) => {
		try {
			return await act(event, async (ctx, companyId, form) => {
				const token = formText(form, 'token').trim();
				const rotated = await rotateSecret(
					deps(),
					ctx,
					companyId,
					formText(form, 'subscriptionId'),
					token === '' ? {} : { token }
				);
				return rotated.secret === null
					? { tokenReplaced: true }
					: { secret: { name: rotated.subscription.name, value: rotated.secret } };
			});
		} catch (cause) {
			return formFailure(cause);
		}
	},
	ping: async (event) => {
		try {
			return await act(event, async (ctx, companyId, form) => {
				await sendPing(deps(), ctx, companyId, formText(form, 'subscriptionId'));
				return { pinged: true };
			});
		} catch (cause) {
			return formFailure(cause);
		}
	},
	remove: async (event) => {
		try {
			return await act(event, async (ctx, companyId, form) => {
				await deleteSubscription(deps(), ctx, companyId, formText(form, 'subscriptionId'));
				return { removed: true };
			});
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
