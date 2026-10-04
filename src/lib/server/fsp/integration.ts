// The configured FSP achievements integration: adapter, grant issuer and receipt signer from `config()`, built on
// first use so that `vite build` does not need the runtime environment.
import { config } from '$lib/server/config';
import { HttpAchievementsSource } from './adapter';
import { ServiceGrantIssuer, type GrantIssuer } from './grant';
import { configuredReceiptSigner, type ReceiptSigner } from './receipts';
import type { AchievementsSource } from './types';

export interface FspIntegration {
	source: AchievementsSource;
	grants: GrantIssuer;
	signer: ReceiptSigner;
}

class FspNotConfiguredError extends Error {
	override name = 'FspNotConfiguredError';
}

let cached: FspIntegration | undefined;

export function fspIntegration(): FspIntegration {
	if (cached) return cached;
	const settings = config();
	const achievements = settings.fspAchievements;
	if (!achievements) throw new FspNotConfiguredError('FSP achievements import is not configured (FSP_ACHIEVEMENTS_*)');
	// The service token of `service_with_assertion` comes from FSP ID (contracts 1.8): both groups are needed.
	if (!settings.fspId)
		throw new FspNotConfiguredError('FSP achievements import needs FSP ID (FSP_ID_*) for its service token');
	cached = {
		source: new HttpAchievementsSource({ baseUrl: achievements.baseUrl, webhookSecret: achievements.webhookSecret }),
		grants: new ServiceGrantIssuer({
			issuer: settings.fspId.issuer,
			clientId: settings.fspId.clientId,
			clientSecret: settings.fspId.clientSecret,
			assertionSecret: achievements.assertionSecret
		}),
		signer: configuredReceiptSigner()
	};
	return cached;
}
