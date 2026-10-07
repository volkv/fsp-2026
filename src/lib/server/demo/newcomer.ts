// A new candidate of a demo session (docs/domain.md, section 19.3): one press on `/demo` writes a fresh candidate
// account into the visitor's live session and signs the browser in as it, so a visitor takes the way of a candidate
// from the first step — the consent, the survey, the declared grade, the test — and the employers of the same session
// find the category it earns. The account is what a registration by password within a session writes (`register`,
// `auth/registration.ts`): confirmed, the user agreement accepted, an adult candidate in onboarding; only the address and
// the name are made up, and there is no password — the browser enters it by this press, as it enters a role of the cast.
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { RequestMeta } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { accountAddress } from '$lib/server/auth/registration';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor } from '$lib/server/db';
import { candidates, demoSessions, documentAcceptances, users } from '$lib/server/db/schema';

/** The domain of the made-up addresses: reserved, never a mailbox. */
const NEWCOMER_DOMAIN = 'newcomer.fsp-career.example';
/** The age the new candidate declares: an adult, so nothing waits for a representative. */
const NEWCOMER_AGE_YEARS = 25;

export class DemoSessionEnded extends Error {
	override name = 'DemoSessionEnded';
}

export interface Newcomer {
	userId: string;
	candidateId: string;
	displayName: string;
}

/** The birth date `years` before `now`, as a candidate types it. */
function birthDateOf(now: Date, years: number): string {
	const date = new Date(now);
	date.setUTCFullYear(date.getUTCFullYear() - years);
	return date.toISOString().slice(0, 10);
}

/**
 * Writes a new candidate into the live demo session `sessionId`: the account confirmed, the current user agreement
 * accepted, the candidate in onboarding with an adult birth date. Throws `DemoSessionEnded` when the session is over.
 */
export async function createNewcomer(
	deps: { db: Database; crypto: FieldCrypto; now: Date },
	sessionId: string,
	meta: RequestMeta
): Promise<Newcomer> {
	const { db, crypto, now } = deps;
	const code = randomBytes(2).toString('hex').toUpperCase();
	const displayName = `Новый кандидат ${code}`;
	const email = accountAddress(`candidate-${randomUUID()}@${NEWCOMER_DOMAIN}`, sessionId);
	return db.transaction(async (tx) => {
		// Held until the commit: the session is neither ended nor removed while its account is being written.
		const [live] = await tx
			.select({ id: demoSessions.id })
			.from(demoSessions)
			.where(and(eq(demoSessions.id, sessionId), gt(demoSessions.expiresAt, now)))
			.for('share');
		if (!live) throw new DemoSessionEnded(`demo session ${sessionId} is over`);
		const agreement = await currentDocument(tx, 'user_agreement', now);
		if (!agreement) throw new Error('no user agreement is published: the stand cannot register a candidate');
		const [user] = await tx
			.insert(users)
			.values({
				status: 'active',
				emailEnc: crypto.encrypt(email, 'users.email'),
				emailHmac: crypto.lookupHmac('email', email),
				emailVerifiedAt: now,
				displayName,
				demoSessionId: sessionId,
				lastLoginAt: now
			})
			.returning({ id: users.id });
		if (!user) throw new Error('the new candidate account was not inserted');
		await tx.insert(documentAcceptances).values({
			documentId: agreement.id,
			userId: user.id,
			acceptedAt: now,
			ip: meta.ip,
			ua: meta.userAgent
		});
		const [candidate] = await tx
			.insert(candidates)
			.values({
				userId: user.id,
				demoSessionId: sessionId,
				searchStatus: 'active',
				preferences: {},
				status: 'onboarding',
				birthDate: birthDateOf(now, NEWCOMER_AGE_YEARS),
				birthDatePrecision: 'day',
				birthDateSource: 'self_declared',
				birthDateStatus: 'unverified'
			})
			.returning({ id: candidates.id });
		if (!candidate) throw new Error('the new candidate profile was not inserted');
		await recordAuditEvent(tx, {
			action: 'auth.registered',
			outcome: 'success',
			actor: { kind: 'user', userId: user.id },
			object: { type: 'user', id: user.id },
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { method: 'demo_newcomer' }
		});
		return { userId: user.id, candidateId: candidate.id, displayName };
	});
}

/**
 * Of the candidates named, those created within a demo session — a new candidate of `/demo` or a registration there —
 * not the clones of the cast (they keep the batch of the seed): an employer of the session tells the visitor's own
 * candidate in a shortlist by it, as the name is not shown before an accepted offer.
 */
export async function createdInSession(executor: Executor, candidateIds: readonly string[]): Promise<Set<string>> {
	if (candidateIds.length === 0) return new Set();
	const rows = await executor
		.select({ id: candidates.id })
		.from(candidates)
		.where(
			and(
				inArray(candidates.id, [...candidateIds]),
				isNotNull(candidates.demoSessionId),
				isNull(candidates.seedBatchId)
			)
		);
	return new Set(rows.map((row) => row.id));
}
