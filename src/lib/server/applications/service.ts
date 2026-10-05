// The candidate's own application to a vacancy (docs/domain.md, 13.5, 13.6; CONCEPT 4 — the secondary way to contact):
// the showcase is the published own vacancies of the companies of the platform within the candidate's reach — no
// external vacancy; the application carries the match of the pair at that moment and discloses the contacts the
// candidate chose to that company (`disclosures` with the application as its basis and the consent scoped to it). The
// candidate sees their applications with statuses; the company sees the applications to its vacancies by pseudonym with
// the match and the disclosed contacts, rejects or invites — an offer the company sends to the applicant marks it
// `invited`. Applications are open to adults: a candidate aged 14–17 is reached by a company through a vacancy for
// minors, with the consent of the representative (domain 7.3).
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { can, companyAdmission, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { currentDocument } from '$lib/server/auth/documents';
import { DISCLOSURE_FIELDS, REQUIRED_DISCLOSURE_FIELDS, type DisclosureField } from '$lib/server/consent/kinds';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor, Transaction } from '$lib/server/db';
import {
	applications,
	candidates,
	companies,
	companyMembers,
	consentEvents,
	disclosures,
	resumeDocuments,
	users,
	vacancies
} from '$lib/server/db/schema';
import { demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { policyViolation } from '$lib/server/errors/api-error';
import { currentDisclosureDocument, effectiveDisclosure } from '$lib/server/invitations/consent';
import { auditActor, channelOf, type RequestMeta } from '$lib/server/invitations/deps';
import { invalid, refuse } from '$lib/server/invitations/errors';
import { candidateSide, memberSide } from '$lib/server/invitations/records';
import { loadCandidateSnapshots, loadGradeOrdinals, vacancySnapshot } from '$lib/server/matching/evidence';
import { loadActiveMatchRuleset } from '$lib/server/matching/ruleset';
import { matchScore, type MatchResult } from '$lib/server/matching/score';
import { notify } from '$lib/server/notifications/notify';
import { ageBand } from '$lib/server/visibility/age';

export interface ApplicationDeps {
	db: Database;
	crypto: Pick<FieldCrypto, 'pseudonym' | 'decrypt'>;
	now: () => Date;
}

export const APPLICATION_MESSAGE_MAX = 2000;

type ApplicationRow = typeof applications.$inferSelect;
type VacancyRow = typeof vacancies.$inferSelect;

/**
 * The match of the pair kept with the application: the score, its components and what it rests on, without the
 * internal fact ids — the company reads it too (domain 14: a company sees receipts, never fact ids).
 */
export interface ApplicationMatch {
	score: number;
	coverage: number;
	ruleset_version: number;
	components: Record<string, { value: number | null; status: string }>;
	matches: Record<string, unknown>[];
	gaps: MatchResult['explanation']['gaps'];
	to_verify: MatchResult['explanation']['to_verify'];
	unknown: MatchResult['explanation']['unknown'];
}

function matchSnapshot(result: MatchResult, rulesetVersion: number): ApplicationMatch {
	return {
		score: result.score,
		coverage: result.coverage,
		ruleset_version: rulesetVersion,
		components: Object.fromEntries(
			Object.entries(result.components).map(([key, component]) => [
				key,
				{ value: component.value, status: component.status }
			])
		),
		matches: result.explanation.matches.map((match) =>
			match.kind === 'skill'
				? {
						kind: match.kind,
						requirement: match.requirement,
						skill_key: match.skill_key,
						band: match.band,
						attestation: match.attestation,
						badge_trust: match.badge_trust
					}
				: { ...match }
		),
		gaps: result.explanation.gaps,
		to_verify: result.explanation.to_verify,
		unknown: result.explanation.unknown
	};
}

/** The match of the candidate with the vacancy now, by the rule set in force, without the models. */
async function pairMatch(
	executor: Executor,
	vacancy: VacancyRow,
	candidateId: string
): Promise<{ result: MatchResult; rulesetVersion: number }> {
	const snapshot = (await loadCandidateSnapshots(executor, [candidateId])).get(candidateId);
	if (!snapshot) throw new Error(`candidate ${candidateId} has no snapshot`);
	const ruleset = await loadActiveMatchRuleset(executor);
	const ordinals = (await loadGradeOrdinals(executor, [vacancy.taxonomyVersionId])).get(vacancy.taxonomyVersionId);
	if (!ordinals) throw new Error('grade ordinals were not loaded');
	const result = matchScore({
		vacancy: vacancySnapshot(vacancy),
		candidate: snapshot,
		params: ruleset.params,
		gradeOrdinals: ordinals,
		semantic: { status: 'unavailable', reason: 'application_snapshot' },
		reranker: { status: 'unavailable', reason: 'application_snapshot' }
	});
	return { result, rulesetVersion: ruleset.version };
}

/** The snapshot of the match an application keeps. */
async function matchOfPair(executor: Executor, vacancy: VacancyRow, candidateId: string): Promise<ApplicationMatch> {
	const { result, rulesetVersion } = await pairMatch(executor, vacancy, candidateId);
	return matchSnapshot(result, rulesetVersion);
}

function disclosureChoice(fields: readonly string[]): DisclosureField[] {
	const chosen = DISCLOSURE_FIELDS.filter((field) => fields.includes(field));
	if (chosen.length !== new Set(fields).size) throw invalid('disclose_fields', 'Неизвестное поле раскрытия');
	if (!REQUIRED_DISCLOSURE_FIELDS.every((field) => chosen.includes(field))) {
		throw invalid('disclose_fields', 'ФИО и почта раскрываются всегда');
	}
	return chosen;
}

/**
 * A vacancy of the showcase for the candidate: an own published vacancy of a company the admission policy lets act,
 * within the candidate's reach (domain 19.3). An external vacancy, another session's or a missing one is `404`.
 */
async function showcaseVacancy(executor: Executor, userId: string, vacancyId: string) {
	const [row] = await executor
		.select({
			vacancy: vacancies,
			companyStatus: companies.status,
			companyName: companies.displayName,
			demoSessionId: companies.demoSessionId,
			demoOriginal: companies.demoOriginal
		})
		.from(vacancies)
		.innerJoin(companies, eq(companies.id, vacancies.companyId))
		.where(and(eq(vacancies.id, vacancyId), eq(vacancies.origin, 'own')));
	if (!row || !inDemoScope(row, await demoSessionOfUser(executor, userId)))
		throw refuse('not_found', 'not_in_showcase');
	if (!companyAdmission(row.companyStatus).admitted) throw refuse('not_found', 'company_closed');
	return row;
}

export interface ApplyInput {
	vacancyId: string;
	message?: string | null;
	/** The contacts the company receives with the application; full name and email are the required minimum. */
	discloseFields: readonly string[];
	/** The version of the disclosure consent text shown to the candidate. */
	disclosureDocumentId: string;
}

export interface ApplicationView {
	id: string;
	status: ApplicationRow['status'];
	vacancy: { id: string; title: string };
	companyId: string;
	companyName: string;
	/** The candidate for the company: the pseudonym; `null` on the candidate's own side. */
	candidatePseudonym: string | null;
	message: string | null;
	match: ApplicationMatch;
	invitationId: string | null;
	submittedAt: Date;
	viewedAt: Date | null;
	decidedAt: Date | null;
	closedAt: Date | null;
	/** Fields the company may receive under the consent of the application now; empty — revoked or withdrawn. */
	disclosedFields: DisclosureField[];
}

/** The candidate applies to a vacancy of the showcase (`POST /api/v1/me/applications`). */
export async function applyToVacancy(
	deps: ApplicationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: ApplyInput
): Promise<ApplicationView> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.write', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	const message = input.message?.trim() ? input.message.trim() : null;
	if (message !== null && message.length > APPLICATION_MESSAGE_MAX) {
		throw invalid('message', `Сопроводительное сообщение — не длиннее ${APPLICATION_MESSAGE_MAX} символов`);
	}
	const fields = disclosureChoice(input.discloseFields);
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const [candidate] = await tx
			.select({
				birthDate: candidates.birthDate,
				precision: candidates.birthDatePrecision,
				status: candidates.birthDateStatus
			})
			.from(candidates)
			.where(eq(candidates.id, side.candidateId))
			.for('update');
		if (!candidate) throw refuse('not_found', 'no_candidate');
		if (ageBand(candidate, now) !== 'adult') throw policyViolation('application_adult_only');
		await requireProcessingConsent(tx, side.candidateId, now);
		const found = await showcaseVacancy(tx, side.userId, input.vacancyId);
		const vacancy = found.vacancy;
		if (vacancy.status !== 'published' || vacancy.companyId === null || vacancy.createdByMemberId === null) {
			throw refuse('conflict', 'vacancy_closed', [
				{ code: 'vacancy_closed', message: 'Вакансия больше не принимает отклики' }
			]);
		}
		const [existing] = await tx
			.select({ id: applications.id })
			.from(applications)
			.where(and(eq(applications.candidateId, side.candidateId), eq(applications.vacancyId, vacancy.id)));
		if (existing) {
			throw refuse('conflict', 'already_applied', [
				{ code: 'already_applied', message: 'Отклик на эту вакансию уже отправлен' }
			]);
		}
		const document = await currentDisclosureDocument(tx, now);
		if (!document) throw new Error('no contact_disclosure document is published');
		if (input.disclosureDocumentId !== document.id) throw refuse('conflict', 'disclosure_document_changed');

		const [application] = await tx
			.insert(applications)
			.values({
				candidateId: side.candidateId,
				companyId: vacancy.companyId,
				vacancyId: vacancy.id,
				message,
				match: await matchOfPair(tx, vacancy, side.candidateId),
				status: 'submitted',
				submittedAt: now
			})
			.returning();
		if (!application) throw new Error('application was not inserted');
		const [grant] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: side.candidateId,
				kind: 'contact_disclosure',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: side.userId,
				scopeCompanyId: vacancy.companyId,
				scopeApplicationId: application.id,
				scopeFields: fields,
				method: 'separate_screen_button',
				evidence: {
					ip: meta.ip ?? null,
					user_agent: meta.userAgent ?? null,
					session_hash: meta.sessionHash ?? null,
					document_sha256: document.bodySha256
				},
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!grant) throw new Error('consent event not inserted');
		await tx.insert(disclosures).values({
			candidateId: side.candidateId,
			companyId: vacancy.companyId,
			recipientMemberId: await recipientMember(tx, vacancy),
			applicationId: application.id,
			consentEventId: grant.id,
			fields,
			channel: channelOf(subject),
			disclosedAt: now
		});
		const journal = {
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'application', id: application.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			occurredAt: now
		};
		await recordAuditEvent(tx, {
			...journal,
			action: 'consent.granted',
			outcome: 'success',
			details: { kind: 'contact_disclosure', consent_event_id: grant.id, fields }
		});
		await recordAuditEvent(tx, {
			...journal,
			action: 'contacts.disclosed',
			outcome: 'success',
			details: { application_id: application.id, company_id: vacancy.companyId, fields }
		});
		await recordAuditEvent(tx, {
			...journal,
			action: 'application.submitted',
			outcome: 'success',
			details: { vacancy_id: vacancy.id, company_id: vacancy.companyId }
		});
		for (const userId of await companyUsers(tx, vacancy)) {
			await notify(tx, {
				userId,
				type: 'application.received',
				objectId: application.id,
				stage: userId,
				payload: { application_id: application.id }
			});
		}
		const [view] = await viewsOf(tx, deps, [application], 'candidate', now);
		if (!view) throw new Error('view of a new application was not built');
		return view;
	});
}

/** Who of the company receives the disclosure: the author of the vacancy while active, otherwise an active owner. */
async function recipientMember(tx: Transaction, vacancy: VacancyRow): Promise<string> {
	if (vacancy.companyId === null || vacancy.createdByMemberId === null)
		throw new Error(`vacancy ${vacancy.id} is not own`);
	const [author] = await tx
		.select({ status: companyMembers.status })
		.from(companyMembers)
		.where(eq(companyMembers.id, vacancy.createdByMemberId));
	if (author?.status === 'active') return vacancy.createdByMemberId;
	const [owner] = await tx
		.select({ id: companyMembers.id })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, vacancy.companyId),
				eq(companyMembers.role, 'owner'),
				eq(companyMembers.status, 'active')
			)
		)
		.limit(1);
	if (!owner) throw refuse('conflict', 'company_without_members');
	return owner.id;
}

/** The users of the company told about an application: the author of the vacancy while active, otherwise the owners. */
async function companyUsers(tx: Transaction, vacancy: VacancyRow): Promise<string[]> {
	const memberId = await recipientMember(tx, vacancy);
	const [member] = await tx
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.where(eq(companyMembers.id, memberId));
	return member?.userId ? [member.userId] : [];
}

async function viewsOf(
	executor: Executor,
	deps: Pick<ApplicationDeps, 'crypto'>,
	rows: readonly ApplicationRow[],
	side: 'company' | 'candidate',
	now: Date
): Promise<ApplicationView[]> {
	if (rows.length === 0) return [];
	const vacancyRows = new Map(
		(
			await executor
				.select({ id: vacancies.id, title: vacancies.title, companyName: companies.displayName })
				.from(vacancies)
				.innerJoin(companies, eq(companies.id, vacancies.companyId))
				.where(
					inArray(
						vacancies.id,
						rows.map((row) => row.vacancyId)
					)
				)
		).map((row) => [row.id, row])
	);
	const views: ApplicationView[] = [];
	for (const row of rows) {
		const vacancy = vacancyRows.get(row.vacancyId);
		if (!vacancy) throw new Error(`vacancy of application ${row.id} is missing`);
		if (row.match === null) throw new Error(`application ${row.id} is purged`);
		const disclosure =
			row.status === 'withdrawn'
				? null
				: await effectiveDisclosure(executor, row.candidateId, { applicationId: row.id }, now);
		views.push({
			id: row.id,
			status: row.status,
			vacancy: { id: vacancy.id, title: vacancy.title },
			companyId: row.companyId,
			companyName: vacancy.companyName,
			candidatePseudonym: side === 'company' ? deps.crypto.pseudonym(row.candidateId, row.companyId) : null,
			message: row.message,
			match: row.match as ApplicationMatch,
			invitationId: row.invitationId,
			submittedAt: row.submittedAt,
			viewedAt: row.viewedAt,
			decidedAt: row.decidedAt,
			closedAt: row.closedAt,
			disclosedFields: disclosure?.fields ?? []
		});
	}
	return views;
}

export interface ShowcaseVacancy {
	vacancy: {
		id: string;
		title: string;
		description: string | null;
		status: string;
		roleKey: string | null;
		gradeMin: string | null;
		gradeMax: string | null;
		workFormat: string | null;
		requiredSkillKeys: string[];
		niceSkillKeys: string[];
		salary: {
			min: number | null;
			max: number | null;
			currency: string | null;
			taxBase: VacancyRow['salaryTaxBase'];
		};
	};
	company: { id: string; displayName: string; verification: 'verified' | 'unverified' };
	/** The match of the candidate now, with the candidate's own evidence. */
	match: MatchResult;
	/** The candidate's application to it, if any. */
	application: ApplicationView | null;
	/** The text the application consents to; `null` — no disclosure document is published. */
	disclosureDocument: { id: string; title: string; version: number; body: string } | null;
	/** Applications are open to adults only. */
	adult: boolean;
	hasPhone: boolean;
}

/** A vacancy of the showcase as its page shows it to the candidate: the match and the application. */
export async function showcaseVacancyFor(
	deps: ApplicationDeps,
	subject: AccessSubject,
	vacancyId: string
): Promise<ShowcaseVacancy> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.read', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	const now = deps.now();
	const found = await showcaseVacancy(deps.db, side.userId, vacancyId);
	const vacancy = found.vacancy;
	if (vacancy.companyId === null) throw new Error(`own vacancy ${vacancy.id} has no company`);
	const { result } = await pairMatch(deps.db, vacancy, side.candidateId);
	const [row] = await deps.db
		.select()
		.from(applications)
		.where(and(eq(applications.candidateId, side.candidateId), eq(applications.vacancyId, vacancy.id)));
	const [candidate] = await deps.db
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus,
			phone: candidates.phoneEnc
		})
		.from(candidates)
		.where(eq(candidates.id, side.candidateId));
	if (!candidate) throw new Error(`candidate ${side.candidateId} does not exist`);
	const document = await currentDocument(deps.db, 'contact_disclosure', now);
	const [view] = row ? await viewsOf(deps.db, deps, [row], 'candidate', now) : [];
	return {
		vacancy: {
			id: vacancy.id,
			title: vacancy.title,
			description: vacancy.description,
			status: vacancy.status,
			roleKey: vacancy.roleKey,
			gradeMin: vacancy.gradeMin,
			gradeMax: vacancy.gradeMax,
			workFormat: vacancy.workFormat,
			requiredSkillKeys: vacancy.requiredSkillKeys,
			niceSkillKeys: vacancy.niceSkillKeys,
			salary: {
				min: vacancy.salaryMin,
				max: vacancy.salaryMax,
				currency: vacancy.salaryCurrency,
				taxBase: vacancy.salaryTaxBase
			}
		},
		company: {
			id: vacancy.companyId,
			displayName: found.companyName,
			verification: found.companyStatus === 'verified' ? 'verified' : 'unverified'
		},
		match: result,
		application: view ?? null,
		disclosureDocument:
			document?.available === true
				? { id: document.id, title: document.title, version: document.version, body: document.body }
				: null,
		adult: ageBand(candidate, now) === 'adult',
		hasPhone: candidate.phone !== null
	};
}

/** The candidate's applications to companies within reach, newest first (`GET /api/v1/me/applications`). */
export async function myApplications(deps: ApplicationDeps, subject: AccessSubject): Promise<ApplicationView[]> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.read', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	const session = await demoSessionOfUser(deps.db, side.userId);
	const rows = await deps.db
		.select({ application: applications, demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal })
		.from(applications)
		.innerJoin(companies, eq(companies.id, applications.companyId))
		.where(and(eq(applications.candidateId, side.candidateId), isNull(applications.purgedAt)))
		.orderBy(desc(applications.submittedAt));
	return viewsOf(
		deps.db,
		deps,
		rows.filter((row) => inDemoScope(row, session)).map((row) => row.application),
		'candidate',
		deps.now()
	);
}

/**
 * The candidate withdraws an application (`POST /api/v1/me/applications/{id}/withdrawal`): it closes, and the consent
 * to disclose by it is revoked — the company loses further access through the platform; what it received stays with it.
 */
export async function withdrawApplication(
	deps: ApplicationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	applicationId: string
): Promise<ApplicationView> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.write', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const [row] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for('update');
		if (!row || row.candidateId !== side.candidateId || row.purgedAt !== null) throw refuse('not_found', 'not_owner');
		if (row.status === 'withdrawn' || row.status === 'rejected') throw refuse('conflict', 'application_closed');
		const [closed] = await tx
			.update(applications)
			.set({ status: 'withdrawn', closedAt: now })
			.where(eq(applications.id, row.id))
			.returning();
		if (!closed) throw new Error(`application ${row.id} disappeared`);
		const [grant] = await tx
			.select({ documentId: consentEvents.documentId, action: consentEvents.action })
			.from(consentEvents)
			.where(
				and(
					eq(consentEvents.subjectCandidateId, side.candidateId),
					eq(consentEvents.kind, 'contact_disclosure'),
					eq(consentEvents.scopeApplicationId, row.id),
					eq(consentEvents.signerKind, 'subject')
				)
			)
			.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
			.limit(1);
		const journal = {
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'application', id: row.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			occurredAt: now
		};
		if (grant?.action === 'grant') {
			const [revocation] = await tx
				.insert(consentEvents)
				.values({
					subjectCandidateId: side.candidateId,
					kind: 'contact_disclosure',
					documentId: grant.documentId,
					action: 'revoke',
					signerKind: 'subject',
					signerUserId: side.userId,
					scopeCompanyId: row.companyId,
					scopeApplicationId: row.id,
					method: 'separate_screen_button',
					evidence: {
						ip: meta.ip ?? null,
						user_agent: meta.userAgent ?? null,
						session_hash: meta.sessionHash ?? null
					},
					reason: 'application_withdrawn',
					occurredAt: now
				})
				.returning({ id: consentEvents.id });
			if (!revocation) throw new Error('consent event not inserted');
			await recordAuditEvent(tx, {
				...journal,
				action: 'consent.revoked',
				outcome: 'success',
				details: { kind: 'contact_disclosure', consent_event_id: revocation.id }
			});
		}
		await recordAuditEvent(tx, { ...journal, action: 'application.withdrawn', outcome: 'success' });
		const [view] = await viewsOf(tx, deps, [closed], 'candidate', now);
		if (!view) throw new Error('view of an application was not built');
		return view;
	});
}

// --- The company's side -------------------------------------------------------------------------------------------

function managingMember(subject: AccessSubject) {
	const member = memberSide(subject);
	if (!can(subject, 'application.manage', { companyId: member.companyId }).allowed) {
		const admission = companyAdmission(member.companyStatus);
		if (!admission.admitted) throw refuse('forbidden', admission.reason);
		throw refuse('forbidden', 'permission');
	}
	return member;
}

/** The applications to the company's own vacancies, newest first (`GET /api/v1/applications`). */
export async function companyApplications(
	deps: ApplicationDeps,
	subject: AccessSubject,
	filter: { vacancyId?: string; status?: ApplicationRow['status'] } = {}
): Promise<ApplicationView[]> {
	const member = managingMember(subject);
	const rows = await deps.db
		.select()
		.from(applications)
		.where(
			and(
				eq(applications.companyId, member.companyId),
				isNull(applications.purgedAt),
				filter.vacancyId === undefined ? undefined : eq(applications.vacancyId, filter.vacancyId),
				filter.status === undefined ? undefined : eq(applications.status, filter.status)
			)
		)
		.orderBy(desc(applications.submittedAt));
	return viewsOf(deps.db, deps, rows, 'company', deps.now());
}

export interface ApplicationContacts {
	fields: DisclosureField[];
	fullName?: { last: string | null; first: string | null; middle: string | null };
	email?: string;
	phone?: string | null;
	telegram?: string | null;
	resumeFileId?: string | null;
}

/**
 * One application with the contacts the candidate disclosed by it while its consent is in effect
 * (`GET /api/v1/applications/{id}`). The first opening marks it `viewed`; every reading of contacts is journaled.
 */
export async function getApplication(
	deps: ApplicationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	applicationId: string
): Promise<{ application: ApplicationView; contacts: ApplicationContacts | null }> {
	const member = managingMember(subject);
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const [row] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for('update');
		if (!row || row.companyId !== member.companyId || row.purgedAt !== null)
			throw refuse('not_found', 'foreign_application');
		let current = row;
		if (row.status === 'submitted') {
			const [viewed] = await tx
				.update(applications)
				.set({ status: 'viewed', viewedAt: now })
				.where(eq(applications.id, row.id))
				.returning();
			if (!viewed) throw new Error(`application ${row.id} disappeared`);
			current = viewed;
			await recordAuditEvent(tx, {
				action: 'application.decided',
				outcome: 'success',
				actor: auditActor(subject, meta, 'company'),
				object: { type: 'application', id: row.id },
				subjectCandidateId: row.candidateId,
				requestId: meta.requestId,
				details: { decision: 'viewed' },
				occurredAt: now
			});
		}
		const [view] = await viewsOf(tx, deps, [current], 'company', now);
		if (!view) throw new Error('view of an application was not built');
		const disclosure =
			current.status === 'withdrawn'
				? null
				: await effectiveDisclosure(tx, current.candidateId, { applicationId: current.id }, now);
		if (!disclosure) return { application: view, contacts: null };
		const contacts = await readContacts(tx, deps, current.candidateId, disclosure.fields);
		await recordAuditEvent(tx, {
			action: 'card.viewed_recipient',
			outcome: 'success',
			actor: auditActor(subject, meta, 'company'),
			object: { type: 'application', id: current.id },
			subjectCandidateId: current.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { fields: disclosure.fields, consent_event_id: disclosure.consentEventId },
			occurredAt: now
		});
		return { application: view, contacts };
	});
}

async function readContacts(
	executor: Executor,
	deps: Pick<ApplicationDeps, 'crypto'>,
	candidateId: string,
	fields: readonly DisclosureField[]
): Promise<ApplicationContacts> {
	const [candidate] = await executor
		.select({
			lastNameEnc: candidates.lastNameEnc,
			firstNameEnc: candidates.firstNameEnc,
			middleNameEnc: candidates.middleNameEnc,
			phoneEnc: candidates.phoneEnc,
			telegramEnc: candidates.telegramEnc,
			emailEnc: users.emailEnc
		})
		.from(candidates)
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(eq(candidates.id, candidateId));
	if (!candidate) throw new Error(`candidate ${candidateId} does not exist`);
	const open = (value: Uint8Array | null, context: Parameters<typeof deps.crypto.decrypt>[1]) =>
		value === null ? null : deps.crypto.decrypt(value, context);
	const chosen = new Set(fields);
	const contacts: ApplicationContacts = { fields: [...fields] };
	if (chosen.has('full_name')) {
		contacts.fullName = {
			last: open(candidate.lastNameEnc, 'candidates.last_name'),
			first: open(candidate.firstNameEnc, 'candidates.first_name'),
			middle: open(candidate.middleNameEnc, 'candidates.middle_name')
		};
	}
	if (chosen.has('email')) {
		const email = open(candidate.emailEnc, 'users.email');
		if (email === null) throw new Error(`user of candidate ${candidateId} has no email`);
		contacts.email = email;
	}
	if (chosen.has('phone')) contacts.phone = open(candidate.phoneEnc, 'candidates.phone');
	if (chosen.has('telegram')) contacts.telegram = open(candidate.telegramEnc, 'candidates.telegram');
	if (chosen.has('resume')) {
		const [resume] = await executor
			.select({ fileId: resumeDocuments.fileId })
			.from(resumeDocuments)
			.where(and(eq(resumeDocuments.candidateId, candidateId), eq(resumeDocuments.isCurrent, true)));
		contacts.resumeFileId = resume?.fileId ?? null;
	}
	return contacts;
}

/** The company declines an application (`POST /api/v1/applications/{id}/rejection`); the candidate is told. */
export async function rejectApplication(
	deps: ApplicationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	applicationId: string
): Promise<ApplicationView> {
	const member = managingMember(subject);
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const [row] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for('update');
		if (!row || row.companyId !== member.companyId || row.purgedAt !== null)
			throw refuse('not_found', 'foreign_application');
		if (row.status !== 'submitted' && row.status !== 'viewed') throw refuse('conflict', 'application_closed');
		const [rejected] = await tx
			.update(applications)
			.set({ status: 'rejected', decidedAt: now, closedAt: now, viewedAt: row.viewedAt ?? now })
			.where(eq(applications.id, row.id))
			.returning();
		if (!rejected) throw new Error(`application ${row.id} disappeared`);
		await decided(tx, rejected, 'rejected', auditActor(subject, meta, 'company'), meta.requestId, now);
		const [view] = await viewsOf(tx, deps, [rejected], 'company', now);
		if (!view) throw new Error('view of an application was not built');
		return view;
	});
}

async function decided(
	tx: Transaction,
	row: ApplicationRow,
	decision: 'invited' | 'rejected',
	actor: AuditActor,
	requestId: string,
	now: Date
): Promise<void> {
	const [candidate] = await tx
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, row.candidateId));
	if (!candidate) throw new Error(`candidate ${row.candidateId} does not exist`);
	await notify(tx, {
		userId: candidate.userId,
		type: 'application.decided',
		objectId: row.id,
		stage: decision,
		payload: { application_id: row.id, decision }
	});
	await recordAuditEvent(tx, {
		action: 'application.decided',
		outcome: 'success',
		actor,
		object: { type: 'application', id: row.id },
		subjectCandidateId: row.candidateId,
		requestId,
		details: { decision },
		occurredAt: now
	});
}

/**
 * The candidate's own application to the company that lets it offer to them outside the catalog (domain 13.13): an
 * application not withdrawn or rejected, whose disclosure consent is in effect. Returns its id, or `null`.
 */
export async function applicationBasis(
	executor: Executor,
	pair: { companyId: string; candidateId: string },
	now: Date
): Promise<string | null> {
	const rows = await executor
		.select({ id: applications.id })
		.from(applications)
		.where(
			and(
				eq(applications.companyId, pair.companyId),
				eq(applications.candidateId, pair.candidateId),
				isNull(applications.purgedAt),
				inArray(applications.status, ['submitted', 'viewed', 'invited'])
			)
		)
		.orderBy(desc(applications.submittedAt));
	for (const row of rows) {
		if (await effectiveDisclosure(executor, pair.candidateId, { applicationId: row.id }, now)) {
			return row.id;
		}
	}
	return null;
}

/**
 * An offer of the company to the candidate answers the open applications of the pair (domain 13.5): they become
 * `invited` with the offer. Called in the transaction of the sent version.
 */
export async function markApplicationsInvited(
	tx: Transaction,
	pair: { candidateId: string; companyId: string; invitationId: string },
	journal: { actor: AuditActor; requestId: string; now: Date }
): Promise<void> {
	const { now } = journal;
	const invited = await tx
		.update(applications)
		.set({ status: 'invited', invitationId: pair.invitationId, decidedAt: now })
		.where(
			and(
				eq(applications.candidateId, pair.candidateId),
				eq(applications.companyId, pair.companyId),
				inArray(applications.status, ['submitted', 'viewed'])
			)
		)
		.returning();
	for (const row of invited) await decided(tx, row, 'invited', journal.actor, journal.requestId, now);
}
