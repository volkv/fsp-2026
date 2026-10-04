// The demo services of this stand, built from the configuration. Refuses outside the demonstration mode: the seed and
// the reset rewrite the whole database, so a stand with real data never runs them.
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { docparse } from '$lib/server/documents/docparse';
import { fspIntegration } from '$lib/server/fsp/integration';
import type { JobLogger } from '$lib/server/jobs/log';
import { redis } from '$lib/server/redis';
import { objectStore } from '$lib/server/storage/object-store';
import { seedsDirectory } from './data';
import type { DemoServices } from './services';

class DemoModeOff extends Error {
	override name = 'DemoModeOff';
}

export async function configuredDemoServices(log: JobLogger): Promise<DemoServices> {
	const settings = config();
	if (!settings.demo) {
		throw new DemoModeOff(
			'DEMO_MODE is not true: the demo seed and reset rewrite the whole database and run on a demonstration stand only'
		);
	}
	// The configuration refuses demonstration mode without the simulator (config.ts); the check names the reason here.
	if (!settings.fspId || settings.fspAchievements?.adapter !== 'mock') {
		throw new DemoModeOff('demonstration mode needs FSP ID and the achievements source of the simulator');
	}
	return {
		db: db(),
		redis: await redis(),
		crypto: fieldCrypto(),
		store: objectStore(),
		parser: docparse(),
		fsp: fspIntegration(),
		fspIdIssuer: settings.fspId.issuer,
		fspMockOrigin: settings.fspAchievements.baseUrl,
		settings: settings.demo,
		appOrigin: settings.appOrigin,
		seedsDir: seedsDirectory(),
		log
	};
}
