// The rest of the registration path (domain 3.6, 6.3, 6.4, 7.3, 12.2): the personal-data consent on its own screen, the
// legal representative of a candidate aged 14–17 (the invitation only — authority is checked by an FSP operator), the
// return of a person refused for age once the day of eligibility has come, and the state of the survey and the declared
// grade, which complete the registration of a candidate.
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent } from '$lib/server/audit/record';
import { recordProfileChange } from '$lib/server/candidates/settings';
import { currentDeclaration } from '$lib/server/grades/policy';
import { latestSurvey } from '$lib/server/grades/surveys';
import { consentSides } from '$lib/server/consent/effective';
import type { Executor } from '$lib/server/db';
import {
	candidates,
	companies,
	companyMembers,
	consentEvents,
	legalRepresentatives,
	representations,
	users
} from '$lib/server/db/schema';
import { representativeInviteLetter } from '$lib/server/mail/templates';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { decideAge, minorsAllowed, parseBirthDate } from './age';
import type { AuthDeps, RequestMeta } from './context';
import { stillCurrent } from './documents';
import { consumeEmailToken, issueEmailToken } from './email-tokens';
import type { SessionRef } from './sessions';

type CandidateStatus = 'onboarding' | 'active' | 'ineligible_age' | 'deletion_pending' | 'deleted';
type RepresentationStatus = 'invited' | 'contact_confirmed' | 'authority_pending' | 'authority_verified' | 'ended';

export interface OnboardingState {
	emailVerified: boolean;
	role: 'candidate' | 'employer' | null;
	candidate: {
		id: string;
		status: CandidateStatus;
		/** Only for `ineligible_age`: the day a profile becomes possible. */
		eligibleFrom: string | null;
		/** 14–17 on the day of the request. */
		minor: boolean;
		profileConsent: boolean;
		/** The current representation, if any was requested and has not ended. */
		representative: RepresentationStatus | null;
		/** The survey in force (domain 12.2); `null` — not taken yet. */
		survey: { version: number; specialization: SpecializationKey } | null;
		/** The current declaration of the survey's specialization; `null` — not declared yet. */
		declaredGrade: GradeKey | null;
	} | null;
	company: {
		id: string;
		displayName: string;
		status: 'draft' | 'submitted' | 'verified' | 'rejected' | 'suspended';
	} | null;
	/** Every step the person can take has been taken. */
	complete: boolean;
}

/**
 * Where the registration goes once the processing consent is given: straight to the survey when it is the next step of an
 * adult with a confirmed address; otherwise — a minor, whose representative comes first, an address to confirm, a
 * consent that did not open the profile — back to the list of steps, which shows what is left.
 */
export function stepAfterConsent(state: OnboardingState): '/onboarding/survey' | '/onboarding' {
	const candidate = state.candidate;
	return state.emailVerified && candidate?.status === 'active' && !candidate.minor && candidate.survey === null
		? '/onboarding/survey'
		: '/onboarding';
}

export async function onboardingState(deps: AuthDeps, userId: string): Promise<OnboardingState> {
	const now = deps.now();
	const [user] = await deps.db.select({ verifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, userId));
	if (!user) throw new Error(`user ${userId} does not exist`);
	const emailVerified = user.verifiedAt !== null;

	const [candidate] = await deps.db
		.select({
			id: candidates.id,
			status: candidates.status,
			eligibleFrom: candidates.eligibleFrom,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.userId, userId));
	if (candidate) {
		const band = ageBand(
			{ birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.birthStatus },
			now
		);
		const profileConsent = await subjectGrantInForce(deps, candidate.id);
		const [representation] = await deps.db
			.select({ status: representations.status })
			.from(representations)
			.where(and(eq(representations.candidateId, candidate.id), ne(representations.status, 'ended')))
			.orderBy(desc(representations.invitedAt))
			.limit(1);
		const minor = isMinorBand(band);
		const representative = representation?.status ?? null;
		const survey = await latestSurvey(deps.db, candidate.id);
		const declaration = survey && (await currentDeclaration(deps.db, candidate.id, survey.specialization));
		return {
			emailVerified,
			role: 'candidate',
			candidate: {
				id: candidate.id,
				status: candidate.status,
				eligibleFrom: candidate.eligibleFrom,
				minor,
				profileConsent,
				representative,
				survey: survey && { version: survey.version, specialization: survey.specialization },
				declaredGrade: declaration?.grade ?? null
			},
			company: null,
			// Registration of a candidate is complete with a survey and a declaration (domain 12.2).
			complete:
				emailVerified &&
				candidate.status === 'active' &&
				(!minor || representative !== null) &&
				survey !== null &&
				declaration !== null
		};
	}

	const [membership] = await deps.db
		.select({ id: companies.id, displayName: companies.displayName, status: companies.status })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(and(eq(companyMembers.userId, userId), eq(companyMembers.status, 'active')));
	if (membership) {
		return { emailVerified, role: 'employer', candidate: null, company: membership, complete: emailVerified };
	}
	return { emailVerified, role: null, candidate: null, company: null, complete: emailVerified };
}

/** Whether the subject's last `pd_processing` event is a grant. */
async function subjectGrantInForce(deps: AuthDeps, candidateId: string): Promise<boolean> {
	const [last] = await deps.db
		.select({ action: consentEvents.action })
		.from(consentEvents)
		.where(and(eq(consentEvents.subjectCandidateId, candidateId), eq(consentEvents.kind, 'pd_processing')))
		.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
		.limit(1);
	return last?.action === 'grant';
}

export type ConsentResult = { ok: true } | { ok: false; reason: 'not_applicable' | 'document_changed' };

/**
 * `pd_processing` from the subject on its own screen (domain 6.2): the candidate profile opens (`onboarding → active`,
 * domain 7.1). For 14–17 the profile stays hidden until a verified representative signs as well (domain 7.3).
 *
 * An active candidate whose own side is not in force signs again on the same terms: after 18 the consents signed
 * during minority count no more (domain 6.3, rule 4), and a version published with `requires_reconsent` replaces the
 * previous text. The profile stays active; its processing resumes by the new grant.
 */
export async function grantProfileConsent(
	deps: AuthDeps,
	meta: RequestMeta,
	session: SessionRef,
	documentId: string
): Promise<ConsentResult> {
	const now = deps.now();
	const userId = session.userId;
	return deps.db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({
				id: candidates.id,
				status: candidates.status,
				birthDate: candidates.birthDate,
				precision: candidates.birthDatePrecision,
				birthStatus: candidates.birthDateStatus
			})
			.from(candidates)
			.where(eq(candidates.userId, userId))
			.for('update');
		if (candidate?.status !== 'onboarding' && candidate?.status !== 'active') {
			return { ok: false, reason: 'not_applicable' } as const;
		}
		const band = ageBand(
			{ birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.birthStatus },
			now
		);
		if (band === 'unknown' || band === 'under_14') return { ok: false, reason: 'not_applicable' } as const;
		const renewal = candidate.status === 'active';
		if (renewal && (await ownProcessingConsent(tx, candidate.id, now))) {
			return { ok: false, reason: 'not_applicable' } as const;
		}
		const document = await stillCurrent(tx, 'pd_processing', documentId, now);
		if (!document?.available) return { ok: false, reason: 'document_changed' } as const;
		const [consent] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidate.id,
				kind: 'pd_processing',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: userId,
				method: 'separate_screen_button',
				evidence: {
					ip: meta.ip,
					user_agent: meta.userAgent,
					session_hash: session.hash,
					document_sha256: document.bodySha256
				},
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!consent) throw new Error('consent event was not inserted');
		if (renewal) {
			await recordProfileChange(tx, candidate.id, {
				evidenceInput: true,
				createdBy: { kind: 'user', id: userId }
			});
		} else {
			await tx.update(candidates).set({ status: 'active' }).where(eq(candidates.id, candidate.id));
		}
		await recordAuditEvent(tx, {
			action: 'consent.granted',
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'consent_event', id: consent.id },
			subjectCandidateId: candidate.id,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { kind: 'pd_processing', document_version: document.version }
		});
		return { ok: true } as const;
	});
}

/**
 * Whether the candidate's own side of `pd_processing` is in force: the last own grant, not replaced by a version with
 * `requires_reconsent`, and for an adult signed after majority.
 */
export async function ownProcessingConsent(executor: Executor, candidateId: string, now: Date): Promise<boolean> {
	return (
		(await consentSides(executor, candidateId, ['pd_processing'], null, now)).get('pd_processing')?.subject != null
	);
}

export const REPRESENTATION_RELATIONS = ['parent', 'adoptive_parent', 'guardian', 'custodian'] as const;
export type RepresentationRelation = (typeof REPRESENTATION_RELATIONS)[number];

export type RepresentativeField = 'fullName' | 'email' | 'relation';

export type InviteResult =
	| { ok: true; letterSent: boolean }
	| { ok: false; reason: 'not_applicable' }
	| { ok: false; reason: 'invalid'; errors: Partial<Record<RepresentativeField, string>> };

const emailSchema = z.email().max(254);

export function representativeLink(appOrigin: string, token: string): string {
	return `${appOrigin}/representative/confirm?token=${encodeURIComponent(token)}`;
}

/**
 * The candidate aged 14–17 names a legal representative (domain 6.4): contacts are stored encrypted, the
 * representation starts as `invited`, and a letter asks the representative to confirm the address.
 */
export async function inviteRepresentative(
	deps: AuthDeps,
	meta: RequestMeta,
	session: SessionRef,
	input: { fullName: string; email: string; relation: string }
): Promise<InviteResult> {
	const now = deps.now();
	const userId = session.userId;
	const fullName = input.fullName.trim();
	const email = input.email.trim();
	const errors: Partial<Record<RepresentativeField, string>> = {};
	if (fullName.length < 5 || fullName.length > 200) errors.fullName = 'Укажите фамилию, имя и отчество представителя';
	if (!emailSchema.safeParse(email).success) errors.email = 'Укажите адрес почты полностью';
	const relation = REPRESENTATION_RELATIONS.find((value) => value === input.relation);
	if (!relation) errors.relation = 'Выберите, кем вам приходится представитель';
	const emailHmac = deps.crypto.lookupHmac('email', email);
	const [own] = await deps.db.select({ emailHmac: users.emailHmac }).from(users).where(eq(users.id, userId));
	if (own?.emailHmac === emailHmac) errors.email = 'Укажите адрес представителя, а не свой';
	if (Object.keys(errors).length > 0 || !relation) return { ok: false, reason: 'invalid', errors };

	const invited = await deps.db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({
				id: candidates.id,
				status: candidates.status,
				birthDate: candidates.birthDate,
				precision: candidates.birthDatePrecision,
				birthStatus: candidates.birthDateStatus
			})
			.from(candidates)
			.where(eq(candidates.userId, userId))
			.for('update');
		if (!candidate || candidate.status !== 'active') return null;
		const band = ageBand(
			{ birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.birthStatus },
			now
		);
		if (!isMinorBand(band)) return null;
		const [open] = await tx
			.select({ id: representations.id })
			.from(representations)
			.where(and(eq(representations.candidateId, candidate.id), ne(representations.status, 'ended')));
		if (open) return null;
		const [representative] = await tx
			.insert(legalRepresentatives)
			.values({
				fullNameEnc: deps.crypto.encrypt(fullName, 'legal_representatives.full_name'),
				emailEnc: deps.crypto.encrypt(email, 'legal_representatives.email'),
				emailHmac
			})
			.returning({ id: legalRepresentatives.id });
		if (!representative) throw new Error('representative was not inserted');
		const [representation] = await tx
			.insert(representations)
			.values({
				candidateId: candidate.id,
				representativeId: representative.id,
				relation,
				status: 'invited',
				invitedAt: now
			})
			.returning({ id: representations.id });
		if (!representation) throw new Error('representation was not inserted');
		const token = await issueEmailToken(tx, 'representative_invite', { targetRef: representation.id }, now);
		await recordAuditEvent(tx, {
			action: 'representation.invited',
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'representation', id: representation.id },
			subjectCandidateId: candidate.id,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { relation }
		});
		return token;
	});
	if (invited === null) return { ok: false, reason: 'not_applicable' };

	const [user] = await deps.db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
	const sent = await deps.mailer.send(
		representativeInviteLetter(email, {
			representativeName: fullName,
			candidateName: user?.displayName ?? 'Кандидат',
			link: representativeLink(deps.appOrigin, invited)
		})
	);
	if (!sent.ok) console.error(`[auth] representative letter not sent: ${sent.error.code} ${sent.error.message}`);
	return { ok: true, letterSent: sent.ok };
}

/** The representative followed the link: `invited → contact_confirmed` (domain 6.4). Proves the address only. */
export async function confirmRepresentativeContact(
	deps: AuthDeps,
	meta: RequestMeta,
	token: string
): Promise<{ ok: true } | { ok: false; reason: 'invalid_token' }> {
	const now = deps.now();
	return deps.db.transaction(async (tx) => {
		const consumed = await consumeEmailToken(tx, 'representative_invite', token, now);
		if (consumed?.targetRef == null) return { ok: false, reason: 'invalid_token' } as const;
		const [representation] = await tx
			.update(representations)
			.set({ status: 'contact_confirmed', contactConfirmedAt: now })
			.where(and(eq(representations.id, consumed.targetRef), eq(representations.status, 'invited')))
			.returning({ id: representations.id, candidateId: representations.candidateId });
		if (!representation) return { ok: false, reason: 'invalid_token' } as const;
		await recordAuditEvent(tx, {
			action: 'representation.contact_confirmed',
			outcome: 'success',
			actor: { kind: 'anonymous' },
			object: { type: 'representation', id: representation.id },
			subjectCandidateId: representation.candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent
		});
		return { ok: true } as const;
	});
}

export type RedeclareResult =
	{ ok: true; eligible: boolean } | { ok: false; reason: 'not_applicable' | 'invalid_date' };

/**
 * A person refused for age comes back on or after `eligible_from` (domain 7.1: `ineligible_age → onboarding`) and
 * states the birth date again.
 */
export async function redeclareBirthDate(
	deps: AuthDeps,
	session: SessionRef,
	birthDate: string
): Promise<RedeclareResult> {
	const now = deps.now();
	if (parseBirthDate(birthDate, now) === null) return { ok: false, reason: 'invalid_date' };
	return deps.db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({ id: candidates.id, status: candidates.status, eligibleFrom: candidates.eligibleFrom })
			.from(candidates)
			.where(eq(candidates.userId, session.userId))
			.for('update');
		const today = now.toISOString().slice(0, 10);
		if (candidate?.status !== 'ineligible_age' || candidate.eligibleFrom === null || candidate.eligibleFrom > today) {
			return { ok: false, reason: 'not_applicable' } as const;
		}
		const decision = decideAge(birthDate, now, await minorsAllowed(tx, now));
		await tx
			.update(candidates)
			.set(
				decision.kind === 'eligible'
					? {
							status: 'onboarding',
							eligibleFrom: null,
							birthDate,
							birthDatePrecision: 'day',
							birthDateSource: 'self_declared',
							birthDateStatus: 'unverified'
						}
					: { eligibleFrom: decision.eligibleFrom }
			)
			.where(eq(candidates.id, candidate.id));
		return { ok: true, eligible: decision.kind === 'eligible' } as const;
	});
}
