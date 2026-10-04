// Registration (domain 3.6): credentials — a password or a return from FSP ID — together with the role, the birth date
// of a candidate or the company of an employer and the user agreement, in one transaction. The personal-data consent
// follows on its own screen (onboarding.ts); the address is confirmed by our link only. On a demonstration stand every
// registration — by password or after a return from FSP ID — takes place within the visitor's demo session
// (docs/domain.md, 19.3): the account, its identity, profile and company belong to the session and go with it, and the
// address is the session's form of the one typed, so visitors of other sessions register the same athlete and address
// with accounts of their own. The session's form of an address is no mailbox the visitor reads: such an account is
// created confirmed, as the clones of the cast are, and no letter is sent.
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordAuditEvent } from '$lib/server/audit/record';
import { innConflict } from '$lib/server/companies/inn-scope';
import {
	candidates,
	companies,
	companyMembers,
	demoSessions,
	documentAcceptances,
	externalIdentities,
	passwordCredentials,
	users
} from '$lib/server/db/schema';
import { cloneEmail } from '$lib/server/demo/cast';
import { decideAge, minorsAllowed, parseBirthDate } from './age';
import type { AuthDeps, RequestMeta } from './context';
import { stillCurrent } from './documents';
import { issueEmailToken } from './email-tokens';
import type { PendingSignup } from './fsp-signup';
import type { DemoSessionRefusal, VisitorDemoSession } from './identities';
import { isValidInn } from './inn';
import { hashPassword, passwordProblems } from './password';
import { createSession } from './sessions';
import { sendVerificationLetter } from './verification';

export type Role = 'candidate' | 'employer';

export interface RegistrationInput {
	email: string;
	displayName: string;
	/** `null` only for a registration after FSP ID: such an account may have no password (domain 3.2). */
	password: string | null;
	role: Role;
	/** `YYYY-MM-DD`, for a candidate. */
	birthDate: string | null;
	/** For an employer. */
	company: { inn: string; name: string } | null;
	/** Versions shown on the form. */
	documents: { userAgreementId: string; employerTermsId: string | null };
	fsp: PendingSignup | null;
	/**
	 * On a demonstration stand, for a registration by password: the visitor's demo session, opened for them when the
	 * browser has none; asked for only once the form is valid. A registration after FSP ID takes place in the session the
	 * held result names (`fsp.demoSessionId`) and passes `null`.
	 */
	demoSession: VisitorDemoSession | null;
}

export type RegistrationField =
	'email' | 'displayName' | 'password' | 'birthDate' | 'inn' | 'companyName' | 'documents';

export type RegistrationResult =
	| {
			ok: true;
			userId: string;
			sessionId: string;
			/**
			 * The letter confirming the address: `not_sent` — the account exists but the letter did not leave, the person can
			 * ask for it again; `not_needed` — an account of a demo session, created confirmed.
			 */
			letter: 'sent' | 'not_sent' | 'not_needed';
	  }
	| { ok: false; errors: Partial<Record<RegistrationField, string>> }
	/** The visitor's demo session could not be had (`demo/visit.ts`): nothing was written. */
	| { ok: false; demoRefused: DemoSessionRefusal };

const emailSchema = z.email().max(254);

/** The address an account keeps: within a demo session, the session's form of it, as its clones have. */
export function accountAddress(email: string, demoSessionId: string | null): string {
	return demoSessionId === null ? email : cloneEmail(email, demoSessionId);
}
const MAX_NAME = 120;

function validate(input: RegistrationInput, now: Date): Partial<Record<RegistrationField, string>> {
	const errors: Partial<Record<RegistrationField, string>> = {};
	if (!emailSchema.safeParse(input.email).success)
		errors.email = 'Укажите адрес почты полностью, например name@example.ru';
	const name = input.displayName.trim();
	if (name.length < 2 || name.length > MAX_NAME) errors.displayName = `Имя — от 2 до ${MAX_NAME} символов`;
	if (input.password === null) {
		if (input.fsp === null) errors.password = 'Придумайте пароль';
	} else {
		const problems = passwordProblems(input.password, input.email);
		if (problems.length > 0) errors.password = problems.join('. ');
	}
	if (input.role === 'candidate') {
		if (input.birthDate === null || parseBirthDate(input.birthDate, now) === null) {
			errors.birthDate = 'Укажите настоящую дату рождения';
		}
	} else {
		if (input.company === null || !isValidInn(input.company.inn)) {
			errors.inn = 'ИНН — 10 цифр для организации или 12 для ИП, с верной контрольной суммой';
		}
		const companyName = input.company?.name.trim() ?? '';
		if (companyName.length < 2 || companyName.length > 200)
			errors.companyName = 'Название компании — от 2 до 200 символов';
		if (input.documents.employerTermsId === null) errors.documents = 'Примите условия для работодателя';
	}
	return errors;
}

class RegistrationRefused extends Error {
	readonly errors: Partial<Record<RegistrationField, string>>;
	constructor(errors: Partial<Record<RegistrationField, string>>) {
		super('registration refused');
		this.errors = errors;
	}
}

export async function register(
	deps: AuthDeps,
	meta: RequestMeta,
	input: RegistrationInput
): Promise<RegistrationResult> {
	const now = deps.now();
	const errors = validate(input, now);
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	if (input.fsp !== null && input.demoSession !== null) {
		throw new Error('a registration after FSP ID takes place in the demo session of the held result');
	}
	let demoSessionId: string | null;
	if (input.fsp !== null) {
		demoSessionId = input.fsp.demoSessionId;
	} else if (input.demoSession !== null) {
		const visit = await input.demoSession();
		if (!visit.ok) return { ok: false, demoRefused: visit.reason };
		demoSessionId = visit.sessionId;
	} else {
		demoSessionId = null;
	}
	const email = accountAddress(input.email.trim(), demoSessionId);
	const emailHmac = deps.crypto.lookupHmac('email', email);
	// Hashing costs tens of milliseconds: done before the transaction, not inside it.
	const passwordHash = input.password === null ? null : await hashPassword(input.password);

	let created: { userId: string; letterToken: string | null };
	try {
		created = await deps.db.transaction(async (tx) => {
			const userAgreement = await stillCurrent(tx, 'user_agreement', input.documents.userAgreementId, now);
			const employerTerms =
				input.role === 'employer' && input.documents.employerTermsId !== null
					? await stillCurrent(tx, 'employer_terms', input.documents.employerTermsId, now)
					: null;
			if (!userAgreement || (input.role === 'employer' && !employerTerms)) {
				throw new RegistrationRefused({
					documents: 'Текст документа обновился — прочитайте новую редакцию и примите её ещё раз'
				});
			}
			if (demoSessionId !== null) {
				// Held until the commit: the session is neither ended nor removed while its account is being written.
				const [live] = await tx
					.select({ id: demoSessions.id })
					.from(demoSessions)
					.where(and(eq(demoSessions.id, demoSessionId), gt(demoSessions.expiresAt, now)))
					.for('share');
				if (!live) {
					throw new RegistrationRefused({
						documents:
							input.fsp === null
								? 'Демо-сессия закончилась. Отправьте форму ещё раз — откроется новая'
								: 'Демо-сессия закончилась. Откройте новую и войдите через ФСП ID ещё раз'
					});
				}
			}

			const [user] = await tx
				.insert(users)
				.values({
					status: demoSessionId === null ? 'pending_email' : 'active',
					emailEnc: deps.crypto.encrypt(email, 'users.email'),
					emailHmac,
					emailVerifiedAt: demoSessionId === null ? null : now,
					displayName: input.displayName.trim(),
					demoSessionId
				})
				.onConflictDoNothing({ target: users.emailHmac, where: sql`status <> 'deleted'` })
				.returning({ id: users.id });
			if (!user) {
				throw new RegistrationRefused({
					email: 'Этот адрес уже зарегистрирован. Войдите или восстановите пароль'
				});
			}
			const userId = user.id;

			if (passwordHash !== null) {
				await tx.insert(passwordCredentials).values({ userId, hash: passwordHash, changedAt: now });
			}
			await tx.insert(documentAcceptances).values({
				documentId: userAgreement.id,
				userId,
				acceptedAt: now,
				ip: meta.ip,
				ua: meta.userAgent
			});

			if (input.fsp !== null) {
				const [identity] = await tx
					.insert(externalIdentities)
					.values({
						userId,
						issuer: input.fsp.issuer,
						subject: input.fsp.subject,
						linkedAt: now,
						linkMethod: 'signup_via_provider',
						lastLoginAt: now,
						demoSessionId,
						profileClaims: {
							name: input.fsp.claims.name ?? null,
							given_name: input.fsp.claims.given_name ?? null,
							family_name: input.fsp.claims.family_name ?? null,
							preferred_username: input.fsp.claims.preferred_username ?? null
						}
					})
					.onConflictDoNothing(
						demoSessionId === null
							? {
									target: [externalIdentities.issuer, externalIdentities.subject],
									where: sql`demo_session_id is null`
								}
							: {
									target: [externalIdentities.issuer, externalIdentities.subject, externalIdentities.demoSessionId],
									where: sql`demo_session_id is not null`
								}
					)
					.returning({ id: externalIdentities.id });
				if (!identity) {
					throw new RegistrationRefused({
						documents: 'Этот ФСП ID уже привязан к другой учётной записи. Войдите через ФСП ID ещё раз'
					});
				}
				await recordAuditEvent(tx, {
					action: 'identity.linked',
					outcome: 'success',
					actor: { kind: 'user', userId },
					object: { type: 'external_identity', id: identity.id },
					requestId: meta.requestId,
					ip: meta.ip,
					userAgent: meta.userAgent,
					details: { link_method: 'signup_via_provider' }
				});
			}

			if (input.role === 'candidate' && input.birthDate !== null) {
				const decision = decideAge(input.birthDate, now, await minorsAllowed(tx, now));
				await tx.insert(candidates).values({
					userId,
					demoSessionId,
					searchStatus: 'active',
					preferences: {},
					...(decision.kind === 'eligible'
						? {
								status: 'onboarding' as const,
								birthDate: input.birthDate,
								birthDatePrecision: 'day' as const,
								birthDateSource: 'self_declared' as const,
								birthDateStatus: 'unverified' as const
							}
						: // Under the age of the profile the birth date is not kept, only the day it opens (domain 7.3).
							{ status: 'ineligible_age' as const, eligibleFrom: decision.eligibleFrom })
				});
			}

			if (input.role === 'employer' && input.company !== null && employerTerms) {
				const name = input.company.name.trim();
				const [company] = await tx
					.insert(companies)
					// The registry name replaces the declared one when the company is checked (domain 5.2).
					.values({ inn: input.company.inn, legalName: name, displayName: name, status: 'draft', demoSessionId })
					.onConflictDoNothing(innConflict(demoSessionId))
					.returning({ id: companies.id });
				// The number is taken within the place of the account: within its demo session, or outside sessions.
				if (!company) {
					throw new RegistrationRefused({
						inn: 'Компания с этим ИНН уже на платформе. Попросите её владельца пригласить вас в команду'
					});
				}
				await tx
					.insert(companyMembers)
					.values({ companyId: company.id, userId, role: 'owner', status: 'active', joinedAt: now });
				await tx.insert(documentAcceptances).values({
					documentId: employerTerms.id,
					userId,
					companyId: company.id,
					acceptedAt: now,
					ip: meta.ip,
					ua: meta.userAgent
				});
			}

			const letterToken = demoSessionId === null ? await issueEmailToken(tx, 'verify_email', { userId }, now) : null;
			await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
			await recordAuditEvent(tx, {
				action: 'auth.registered',
				outcome: 'success',
				actor: { kind: 'user', userId },
				object: { type: 'user', id: userId },
				requestId: meta.requestId,
				ip: meta.ip,
				userAgent: meta.userAgent,
				details: { method: input.fsp === null ? 'password' : 'fsp_id' }
			});
			return { userId, letterToken };
		});
	} catch (error) {
		if (error instanceof RegistrationRefused) return { ok: false, errors: error.errors };
		throw error;
	}

	const letter =
		created.letterToken === null
			? ('not_needed' as const)
			: (await sendVerificationLetter(deps, email, created.letterToken))
				? ('sent' as const)
				: ('not_sent' as const);
	const { sessionId } = await createSession(
		deps.redis,
		{
			userId: created.userId,
			authMethod: input.fsp === null ? 'password' : 'fsp_id',
			authTime: input.fsp === null ? now : new Date(input.fsp.authTime * 1000),
			ip: meta.ip,
			ua: meta.userAgent
		},
		now
	);
	return { ok: true, userId: created.userId, sessionId, letter };
}

/** Whether a live account already uses the address (contracts 2.3, step 3). */
export async function emailInUse(deps: AuthDeps, email: string): Promise<boolean> {
	const [row] = await deps.db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.emailHmac, deps.crypto.lookupHmac('email', email)), ne(users.status, 'deleted')));
	return row !== undefined;
}
