// Dependencies of the external profiles: the database, the clock, the clients of the platforms and the receipt signer.
// The stand calls the public APIs directly from the server; the configuration can point them at a local stand-in.
import { config } from '$lib/server/config';
import { db, type Database } from '$lib/server/db';
import { configuredReceiptSigner, type ReceiptSigner } from '$lib/server/fsp/receipts';
import type { CodeforcesClient } from './codeforces';
import type { GithubClient } from './github';
import type { PlatformHttp } from './http';

export interface ExternalProfileDeps {
	db: Database;
	now: () => Date;
	codeforces: CodeforcesClient;
	github: GithubClient;
	signer: ReceiptSigner;
}

/** The configured database and the public APIs of Codeforces and GitHub. */
export function externalProfileDeps(): ExternalProfileDeps {
	const now = () => new Date();
	const settings = config().publicProfiles;
	const http: PlatformHttp = {
		fetch: (input, init) => fetch(input, init),
		userAgent: `FSP-Career/1.0 (+${config().appOrigin})`,
		timeoutMs: 20_000
	};
	return {
		db: db(),
		now,
		codeforces: { http, baseUrl: settings.codeforcesApiUrl, callIntervalMs: 2_000, now },
		github: { http, baseUrl: settings.githubApiUrl, languageRepos: 5, token: settings.githubToken, now },
		signer: configuredReceiptSigner()
	};
}
