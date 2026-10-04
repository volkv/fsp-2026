// The account an address typed on a form names (domain 3.2–3.4, docs/domain.md, section 19.3). On a demonstration stand
// the browser may have a live demo session, and an account a visitor registered within it keeps the session's form of
// the address (`accountAddress`): the address is looked up there first, then outside sessions. The first account found
// is the answer whatever its status — a blocked account of the session does not hand the form over to an account with
// the same address outside sessions; the caller decides what the status allows.
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import { passwordCredentials, users } from '$lib/server/db/schema';
import { accountAddress } from './registration';

export interface AddressedAccount {
	id: string;
	status: string;
	lockedUntil: Date | null;
	/** The Argon2id hash of the password; `null` — the account has none (created through FSP ID). */
	passwordHash: string | null;
	/** The address the account keeps: the typed one, or its form within the demo session. */
	address: string;
	emailHmac: string;
	/** The demo session the account was registered within; `null` — outside sessions. */
	demoSessionId: string | null;
	/** Seeded, or cloned from a seeded account: an original or a clone of the cast, or the background. */
	seeded: boolean;
}

async function accountIn(
	executor: Executor,
	crypto: FieldCrypto,
	email: string,
	demoSessionId: string | null
): Promise<AddressedAccount | null> {
	const address = accountAddress(email, demoSessionId);
	const emailHmac = crypto.lookupHmac('email', address);
	const [row] = await executor
		.select({
			id: users.id,
			status: users.status,
			lockedUntil: users.lockedUntil,
			passwordHash: passwordCredentials.hash,
			seedBatchId: users.seedBatchId
		})
		.from(users)
		.leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
		.where(
			and(
				eq(users.emailHmac, emailHmac),
				ne(users.status, 'deleted'),
				demoSessionId === null ? isNull(users.demoSessionId) : eq(users.demoSessionId, demoSessionId)
			)
		);
	if (!row) return null;
	return {
		id: row.id,
		status: row.status,
		lockedUntil: row.lockedUntil,
		passwordHash: row.passwordHash,
		address,
		emailHmac,
		demoSessionId,
		seeded: row.seedBatchId !== null
	};
}

/**
 * The account of the typed address (already trimmed and valid): within the live demo session of the browser
 * (`demoSessionId`) first, then outside sessions; `null` — none. A deleted account is none.
 */
export async function accountByAddress(
	executor: Executor,
	crypto: FieldCrypto,
	email: string,
	demoSessionId: string | null
): Promise<AddressedAccount | null> {
	const inSession = demoSessionId === null ? null : await accountIn(executor, crypto, email, demoSessionId);
	return inSession ?? accountIn(executor, crypto, email, null);
}
