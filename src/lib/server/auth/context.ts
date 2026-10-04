// What the sign-in module works with. Routes build it from the configured services; tests pass their own.
import { config } from '$lib/server/config';
import { fieldCrypto, type FieldCrypto } from '$lib/server/crypto/fields';
import { db, type Database } from '$lib/server/db';
import { mailer, type Mailer } from '$lib/server/mail/mailer';
import { redis, type Redis } from '$lib/server/redis';

export interface AuthDeps {
	db: Database;
	redis: Redis;
	crypto: FieldCrypto;
	mailer: Mailer;
	/** Origin of links in messages. */
	appOrigin: string;
	now: () => Date;
}

/** Who sent the request: the journal and consent evidence record it. */
export interface RequestMeta {
	requestId: string;
	ip: string | null;
	userAgent: string | null;
}

export async function authDeps(): Promise<AuthDeps> {
	return {
		db: db(),
		redis: await redis(),
		crypto: fieldCrypto(),
		mailer: mailer(),
		appOrigin: config().appOrigin,
		now: () => new Date()
	};
}
