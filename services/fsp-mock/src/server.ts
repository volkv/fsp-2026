import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { errors, type default as Provider } from 'oidc-provider';

import { handleApi, type ApiContext } from './api/achievements.ts';
import { handleControl } from './api/control.ts';
import { Faults } from './api/faults.ts';
import type { MockConfig } from './config.ts';
import { HttpError, sendError, sendJson } from './http.ts';
import { handleInteraction } from './oidc/interaction.ts';
import { ISSUER_PATH } from './oidc/parity.ts';
import { createProvider } from './oidc/provider.ts';
import { generateWorld } from './seed/generate.ts';
import { Store } from './store.ts';
import { WebhookDispatcher } from './webhooks.ts';

export interface MockApp {
	server: Server;
	provider: Provider;
	store: Store;
	webhooks: WebhookDispatcher;
	faults: Faults;
	issuer: string;
}

export function createMockApp(config: MockConfig, log: (line: string) => void = console.log): MockApp {
	const store = new Store(() => generateWorld({ seed: config.seed, athletes: config.athletes }));
	const provider = createProvider(config, store);
	const webhooks = new WebhookDispatcher(log);
	const faults = new Faults();
	if (config.webhook) {
		webhooks.subscribe({
			url: config.webhook.url,
			secret: config.webhook.secret,
			events: ['result.published', 'result.annulled', 'qualification.assigned', 'athlete.updated']
		});
	}
	const ctx: ApiContext = { provider, store, webhooks, faults, assertionSecret: config.assertionSecret };
	const oidc = provider.callback();

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://internal');
		if (req.method === 'GET' && url.pathname === '/health') {
			sendJson(res, 200, { status: 'ok', datasetId: store.world.datasetId });
			return;
		}
		if (await handleInteraction(provider, store, config.unlistedHeroes, req, res, url)) return;
		if (url.pathname === ISSUER_PATH || url.pathname.startsWith(`${ISSUER_PATH}/`)) {
			// Mounted like a sub-application: the provider sees paths relative to the issuer.
			const mounted = req as IncomingMessage & { originalUrl?: string };
			mounted.originalUrl = req.url;
			req.url = (req.url ?? '/').slice(ISSUER_PATH.length) || '/';
			await oidc(req, res);
			return;
		}
		if (await handleApi(ctx, req, res, url)) return;
		if (await handleControl(ctx, config.controlToken, req, res, url)) return;
		throw new HttpError(404, 'not_found', 'unknown path');
	}

	const server = createServer((req, res) => {
		route(req, res).catch((error: unknown) => {
			if (error instanceof HttpError) {
				if (!res.headersSent) sendError(res, error);
				else res.destroy();
				return;
			}
			if (error instanceof errors.OIDCProviderError && error.statusCode < 500) {
				// E.g. an expired or foreign login interaction: the user starts the sign-in again from the platform.
				if (!res.headersSent)
					sendError(res, new HttpError(error.statusCode, 'invalid_request', error.error_description ?? error.message));
				else res.destroy();
				return;
			}
			log(
				`request ${req.method ?? ''} ${req.url ?? ''} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
			);
			if (!res.headersSent) sendJson(res, 500, { error: { code: 'unavailable', message: 'internal error' } });
			else res.destroy();
		});
	});

	return { server, provider, store, webhooks, faults, issuer: `${config.origin}${ISSUER_PATH}` };
}
