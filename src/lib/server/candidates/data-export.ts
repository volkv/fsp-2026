// «Мои данные» (docs/domain.md, sections 6.5, 18.2; contracts 5.5): everything the platform keeps about the candidate,
// in one JSON document the candidate downloads — the account with its sign-in, FSP ID and notification settings, the
// profile, the resumes with their extracted text, the facts with their claims, experience and receipts, the surveys
// and the grade declarations with their hints, every evidence run with its skills and FSP levels, the categories with
// their history, the objections to test results, the blocked companies, the matches
// with the vacancies the candidate sees, the consents with who signed them, the accepted agreements, the invitations
// with their terms and answers, what was handed to which company, the hiring processes, the tests with their artifacts,
// the notifications, and the journal of actions about the candidate. Other people are named only by what the candidate
// already sees: companies by name, the candidate's own representative; members of companies and operators — by role,
// never by account.
//
// Left out, each for its reason: secrets (the password hash, one-time email and Telegram link tokens), the vectors of
// the profile (`embeddings`) and the records of model calls (`ml_results`) — technical derivatives of the data exported
// here, and the queue of jobs. A candidate account holds no company membership and no staff role (domain 4.1).
// Every export is `data.exported`.
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { AuditActor } from '$lib/server/audit/record';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor } from '$lib/server/db';
import {
	assessmentArtifacts,
	assessmentAttempts,
	assessments,
	assessmentScores,
	assessmentVersions,
	athleteLinks,
	auditEvents,
	authorityChecks,
	candidateCompanyBlocks,
	candidates,
	candidateSurveys,
	categorizationRulesets,
	evidenceRuns,
	claims,
	companies,
	consentEvents,
	disclosures,
	documentAcceptances,
	documentExtractions,
	experienceEntries,
	externalIdentities,
	externalProfiles,
	files,
	fspLevelAssignments,
	gradeDeclarations,
	hiringProcesses,
	hiringReports,
	invitationResponses,
	invitations,
	invitationTerms,
	legalDocuments,
	legalRepresentatives,
	matchRulesets,
	matchScores,
	notificationChannels,
	notificationDeliveries,
	notificationPreferences,
	notifications,
	passwordCredentials,
	representations,
	resumeDocuments,
	skillInferences,
	sourceFacts,
	users,
	vacancies,
	verificationReceipts
} from '$lib/server/db/schema';
import { candidateObjections } from '$lib/server/categories/objections';
import { categoryHistory } from '$lib/server/categories/read';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import { organizationOf } from './vacancies';
import { matchableVacancyFor } from '$lib/server/matching/evidence';
import { COMPONENT_KEYS } from '$lib/server/matching/params';
import { storedComponent } from '$lib/server/matching/storage';

/**
 * v2: `category` is the whole history of categorization runs, not the published one alone. v3: a category is confirmed
 * by a test — `categories` with their history and `objections` to test results; the calculation over the profile is
 * `evidence` (skills, FSP levels, experience) and assigns no category.
 * Also in v3: the way to a category (domain 23.2) — every version of the survey and every grade declaration with its
 * hint.
 */
export const DATA_EXPORT_FORMAT = 'fsp-career-data-export/v3';

const iso = (value: Date | null) => (value === null ? null : value.toISOString());

export interface DataExport {
	format: typeof DATA_EXPORT_FORMAT;
	exported_at: string;
	account: Record<string, unknown>;
	athlete_links: Record<string, unknown>[];
	notification_channels: Record<string, unknown>[];
	notification_preferences: Record<string, unknown>[];
	profile: Record<string, unknown>;
	resumes: Record<string, unknown>[];
	facts: Record<string, unknown>[];
	experience: Record<string, unknown>[];
	external_profiles: Record<string, unknown>[];
	surveys: Record<string, unknown>[];
	grade_declarations: Record<string, unknown>[];
	evidence: Record<string, unknown>[];
	categories: Record<string, unknown>[];
	objections: Record<string, unknown>[];
	company_blocks: Record<string, unknown>[];
	matches: Record<string, unknown>[];
	consents: Record<string, unknown>[];
	document_acceptances: Record<string, unknown>[];
	representatives: Record<string, unknown>[];
	invitations: Record<string, unknown>[];
	disclosures: Record<string, unknown>[];
	hiring: Record<string, unknown>[];
	tests: Record<string, unknown>[];
	notifications: Record<string, unknown>[];
	journal: Record<string, unknown>[];
}

async function companyNames(executor: Executor, ids: readonly string[]): Promise<Map<string, string>> {
	if (ids.length === 0) return new Map();
	const rows = await executor
		.select({ id: companies.id, name: companies.displayName })
		.from(companies)
		.where(inArray(companies.id, [...new Set(ids)]));
	return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * An artifact of an attempt as the candidate may read it: while the attempt is still running, a quiz step keeps only the
 * question and the answer given — whether it was right and the estimate after it are shown once the quiz is over.
 */
function artifactContent(kind: string, content: unknown, running: boolean): unknown {
	if (!running || kind !== 'quiz_step' || content === null || typeof content !== 'object') return content;
	const step = content as Record<string, unknown>;
	return {
		item_id: step.item_id,
		item_version: step.item_version,
		presented_at: step.presented_at,
		answer: step.answer
	};
}

/** The export of the candidate's data as it stands now; reads only. */
async function buildDataExport(
	executor: Executor,
	crypto: FieldCrypto,
	input: { userId: string; candidateId: string; now: Date }
): Promise<DataExport> {
	const { userId, candidateId, now } = input;
	const [user] = await executor.select().from(users).where(eq(users.id, userId));
	const [candidate] = await executor.select().from(candidates).where(eq(candidates.id, candidateId));
	if (!user?.emailEnc || !candidate) throw new Error(`the account ${userId} or its profile is missing`);
	const decrypt = (value: Uint8Array | null, context: Parameters<FieldCrypto['decrypt']>[1]) =>
		value === null ? null : crypto.decrypt(value, context);
	const identities = await executor
		.select({
			issuer: externalIdentities.issuer,
			subject: externalIdentities.subject,
			linkMethod: externalIdentities.linkMethod,
			linkedAt: externalIdentities.linkedAt,
			lastLoginAt: externalIdentities.lastLoginAt,
			profileClaims: externalIdentities.profileClaims
		})
		.from(externalIdentities)
		.where(eq(externalIdentities.userId, userId));
	const [password] = await executor
		.select({ changedAt: passwordCredentials.changedAt })
		.from(passwordCredentials)
		.where(eq(passwordCredentials.userId, userId));
	const athletes = await executor
		.select()
		.from(athleteLinks)
		.where(eq(athleteLinks.userId, userId))
		.orderBy(asc(athleteLinks.linkedAt));
	const channels = await executor
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.userId, userId))
		.orderBy(asc(notificationChannels.linkedAt));
	const preferences = await executor
		.select()
		.from(notificationPreferences)
		.where(eq(notificationPreferences.userId, userId))
		.orderBy(asc(notificationPreferences.category));

	const resumes = await executor
		.select({
			id: resumeDocuments.id,
			seq: resumeDocuments.seq,
			isCurrent: resumeDocuments.isCurrent,
			parseStatus: resumeDocuments.parseStatus,
			name: files.declaredName,
			sizeBytes: files.sizeBytes,
			uploadedAt: resumeDocuments.createdAt
		})
		.from(resumeDocuments)
		.innerJoin(files, eq(files.id, resumeDocuments.fileId))
		.where(eq(resumeDocuments.candidateId, candidateId))
		.orderBy(asc(resumeDocuments.seq));
	const extractions =
		resumes.length === 0
			? []
			: await executor
					.select({
						resumeDocumentId: documentExtractions.resumeDocumentId,
						extractorName: documentExtractions.extractorName,
						extractorVersion: documentExtractions.extractorVersion,
						status: documentExtractions.status,
						text: documentExtractions.text,
						createdAt: documentExtractions.createdAt
					})
					.from(documentExtractions)
					.where(
						inArray(
							documentExtractions.resumeDocumentId,
							resumes.map((resume) => resume.id)
						)
					)
					.orderBy(asc(documentExtractions.createdAt));

	const facts = await executor
		.select()
		.from(sourceFacts)
		.where(eq(sourceFacts.candidateId, candidateId))
		.orderBy(asc(sourceFacts.observedAt));
	const factIds = facts.map((fact) => fact.id);
	const factClaims =
		factIds.length === 0 ? [] : await executor.select().from(claims).where(inArray(claims.factId, factIds));
	const receipts =
		factIds.length === 0
			? []
			: await executor
					.select({
						handle: verificationReceipts.handle,
						factId: verificationReceipts.factId,
						level: verificationReceipts.disclosureLevel,
						audienceCompanyId: verificationReceipts.audienceCompanyId,
						issuedAt: verificationReceipts.issuedAt
					})
					.from(verificationReceipts)
					.where(inArray(verificationReceipts.factId, factIds));
	const experience = await executor
		.select()
		.from(experienceEntries)
		.where(eq(experienceEntries.candidateId, candidateId));
	const profiles = await executor.select().from(externalProfiles).where(eq(externalProfiles.candidateId, candidateId));
	const surveys = await executor
		.select()
		.from(candidateSurveys)
		.where(eq(candidateSurveys.candidateId, candidateId))
		.orderBy(asc(candidateSurveys.version));
	const declarations = await executor
		.select()
		.from(gradeDeclarations)
		.where(eq(gradeDeclarations.candidateId, candidateId))
		.orderBy(asc(gradeDeclarations.declaredAt), asc(gradeDeclarations.id));

	// Every run computed about the candidate, the one in force and the history before it.
	const runs = await executor
		.select({
			run: evidenceRuns,
			rulesetVersion: categorizationRulesets.version
		})
		.from(evidenceRuns)
		.innerJoin(categorizationRulesets, eq(categorizationRulesets.id, evidenceRuns.rulesetId))
		.where(eq(evidenceRuns.candidateId, candidateId))
		.orderBy(asc(evidenceRuns.computedAt), asc(evidenceRuns.id));
	const runIds = runs.map((row) => row.run.id);
	const fspLevels =
		runIds.length === 0
			? []
			: await executor
					.select()
					.from(fspLevelAssignments)
					.where(inArray(fspLevelAssignments.runId, runIds))
					.orderBy(asc(fspLevelAssignments.discipline));
	const inferences = await executor
		.select()
		.from(skillInferences)
		.where(eq(skillInferences.candidateId, candidateId))
		.orderBy(asc(skillInferences.skillKey));
	const categories = (await categoryHistory(executor, candidateId)).reverse();
	const objections = (await candidateObjections(executor, candidateId)).reverse();
	const blocks = await executor
		.select()
		.from(candidateCompanyBlocks)
		.where(eq(candidateCompanyBlocks.candidateId, candidateId))
		.orderBy(asc(candidateCompanyBlocks.createdAt));

	// Stored matches of the vacancies the candidate sees in «Вакансии для меня» (matching/recommendations.ts): the
	// same condition and the same demo scope, so a vacancy hidden from the candidate is not revealed by the export.
	const matches = await executor
		.select({
			vacancyId: vacancies.id,
			vacancyOrigin: vacancies.origin,
			vacancyTitle: vacancies.title,
			vacancyCompanyId: vacancies.companyId,
			vacancyExternalOrg: vacancies.externalOrg,
			vacancyRevision: matchScores.vacancyRevision,
			candidateRevision: matchScores.candidateRevision,
			evidenceRunId: matchScores.evidenceRunId,
			rulesetVersion: matchRulesets.version,
			score: matchScores.score,
			componentStatuses: matchScores.componentStatuses,
			requiredValue: matchScores.requiredValue,
			niceValue: matchScores.niceValue,
			trustValue: matchScores.trustValue,
			gradeValue: matchScores.gradeValue,
			salaryValue: matchScores.salaryValue,
			semanticValue: matchScores.semanticValue,
			rerankerValue: matchScores.rerankerValue,
			roleValue: matchScores.roleValue,
			computedAt: matchScores.computedAt
		})
		.from(matchScores)
		.innerJoin(vacancies, eq(vacancies.id, matchScores.vacancyId))
		.innerJoin(matchRulesets, eq(matchRulesets.id, matchScores.matchRulesetId))
		.where(
			and(eq(matchScores.candidateId, candidateId), matchableVacancyFor(await demoSessionOfUser(executor, userId)))
		)
		.orderBy(asc(matchScores.computedAt), asc(matchScores.id));

	const consents = await executor
		.select({
			id: consentEvents.id,
			kind: consentEvents.kind,
			action: consentEvents.action,
			signerKind: consentEvents.signerKind,
			representationId: consentEvents.representationId,
			scopeCompanyId: consentEvents.scopeCompanyId,
			scopeInvitationId: consentEvents.scopeInvitationId,
			scopeCompetitionRef: consentEvents.scopeCompetitionRef,
			scopeFields: consentEvents.scopeFields,
			method: consentEvents.method,
			reason: consentEvents.reason,
			occurredAt: consentEvents.occurredAt,
			documentTitle: legalDocuments.title,
			documentVersion: legalDocuments.version
		})
		.from(consentEvents)
		.innerJoin(legalDocuments, eq(legalDocuments.id, consentEvents.documentId))
		.where(eq(consentEvents.subjectCandidateId, candidateId))
		.orderBy(asc(consentEvents.occurredAt), asc(consentEvents.id));
	const representatives = await executor
		.select({
			id: representations.id,
			relation: representations.relation,
			status: representations.status,
			invitedAt: representations.invitedAt,
			endedAt: representations.endedAt,
			endReason: representations.endReason,
			fullNameEnc: legalRepresentatives.fullNameEnc,
			emailEnc: legalRepresentatives.emailEnc
		})
		.from(representations)
		.innerJoin(legalRepresentatives, eq(legalRepresentatives.id, representations.representativeId))
		.where(eq(representations.candidateId, candidateId));
	const checks =
		representatives.length === 0
			? []
			: await executor
					.select()
					.from(authorityChecks)
					.where(
						inArray(
							authorityChecks.representationId,
							representatives.map((row) => row.id)
						)
					)
					.orderBy(asc(authorityChecks.checkedAt));
	const acceptances = await executor
		.select({
			companyId: documentAcceptances.companyId,
			acceptedAt: documentAcceptances.acceptedAt,
			ip: documentAcceptances.ip,
			ua: documentAcceptances.ua,
			documentKind: legalDocuments.kind,
			documentTitle: legalDocuments.title,
			documentVersion: legalDocuments.version
		})
		.from(documentAcceptances)
		.innerJoin(legalDocuments, eq(legalDocuments.id, documentAcceptances.documentId))
		.where(eq(documentAcceptances.userId, userId))
		.orderBy(asc(documentAcceptances.acceptedAt));

	const invited = await executor
		.select()
		.from(invitations)
		.where(eq(invitations.candidateId, candidateId))
		.orderBy(asc(invitations.sentAt));
	const invitationIds = invited.map((row) => row.id);
	const terms =
		invitationIds.length === 0
			? []
			: await executor
					.select()
					.from(invitationTerms)
					.where(inArray(invitationTerms.invitationId, invitationIds))
					.orderBy(asc(invitationTerms.version));
	const responses =
		invitationIds.length === 0
			? []
			: await executor
					.select()
					.from(invitationResponses)
					.where(inArray(invitationResponses.invitationId, invitationIds));
	const handedOver = await executor
		.select()
		.from(disclosures)
		.where(eq(disclosures.candidateId, candidateId))
		.orderBy(asc(disclosures.disclosedAt));
	const processes = await executor.select().from(hiringProcesses).where(eq(hiringProcesses.candidateId, candidateId));
	const reports =
		processes.length === 0
			? []
			: await executor
					.select({
						processId: hiringReports.processId,
						party: hiringReports.party,
						kind: hiringReports.kind,
						stage: hiringReports.stage,
						outcome: hiringReports.outcome,
						startDate: hiringReports.startDate,
						reasonCode: hiringReports.reasonCode,
						reportedAt: hiringReports.reportedAt
					})
					.from(hiringReports)
					.where(
						inArray(
							hiringReports.processId,
							processes.map((process) => process.id)
						)
					)
					.orderBy(asc(hiringReports.reportedAt));

	const attempts = await executor
		.select({
			id: assessmentAttempts.id,
			title: assessments.title,
			version: assessmentVersions.version,
			status: assessmentAttempts.status,
			startedAt: assessmentAttempts.startedAt,
			submittedAt: assessmentAttempts.submittedAt,
			deadlineAt: assessmentAttempts.deadlineAt,
			integritySignals: assessmentAttempts.integritySignals,
			annulReason: assessmentAttempts.annulReason
		})
		.from(assessmentAttempts)
		.innerJoin(assessmentVersions, eq(assessmentVersions.id, assessmentAttempts.versionId))
		.innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
		.where(eq(assessmentAttempts.candidateId, candidateId));
	const scores =
		attempts.length === 0
			? []
			: await executor
					.select()
					.from(assessmentScores)
					.where(
						inArray(
							assessmentScores.attemptId,
							attempts.map((attempt) => attempt.id)
						)
					)
					.orderBy(asc(assessmentScores.createdAt));
	const artifacts =
		attempts.length === 0
			? []
			: await executor
					.select({
						attemptId: assessmentArtifacts.attemptId,
						seq: assessmentArtifacts.seq,
						kind: assessmentArtifacts.kind,
						content: assessmentArtifacts.content,
						sha256: assessmentArtifacts.sha256,
						createdAt: assessmentArtifacts.createdAt,
						retentionUntil: assessmentArtifacts.retentionUntil
					})
					.from(assessmentArtifacts)
					.where(
						inArray(
							assessmentArtifacts.attemptId,
							attempts.map((attempt) => attempt.id)
						)
					)
					.orderBy(asc(assessmentArtifacts.seq));

	const received = await executor
		.select()
		.from(notifications)
		.where(eq(notifications.userId, userId))
		.orderBy(asc(notifications.createdAt), asc(notifications.id));
	const deliveries =
		received.length === 0
			? []
			: await executor
					.select({
						notificationId: notificationDeliveries.notificationId,
						channelKind: notificationChannels.kind,
						status: notificationDeliveries.status,
						skipReason: notificationDeliveries.skipReason,
						sentAt: notificationDeliveries.sentAt
					})
					.from(notificationDeliveries)
					.innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
					.where(
						inArray(
							notificationDeliveries.notificationId,
							received.map((row) => row.id)
						)
					);

	const journal = await executor
		.select({
			occurredAt: auditEvents.occurredAt,
			action: auditEvents.action,
			outcome: auditEvents.outcome,
			actorKind: auditEvents.actorKind,
			actorUserId: auditEvents.actorUserId,
			actorCompanyId: auditEvents.actorCompanyId,
			objectType: auditEvents.objectType,
			objectId: auditEvents.objectId,
			details: auditEvents.details
		})
		.from(auditEvents)
		.where(or(eq(auditEvents.subjectCandidateId, candidateId), eq(auditEvents.actorUserId, userId)))
		.orderBy(asc(auditEvents.occurredAt));

	const present = (id: string | null): string[] => (id === null ? [] : [id]);
	const names = await companyNames(executor, [
		...receipts.flatMap((row) => present(row.audienceCompanyId)),
		...blocks.map((row) => row.companyId),
		...matches.flatMap((row) => present(row.vacancyCompanyId)),
		...consents.flatMap((row) => present(row.scopeCompanyId)),
		...acceptances.flatMap((row) => present(row.companyId)),
		...invited.map((row) => row.companyId),
		...handedOver.map((row) => row.companyId),
		...processes.map((row) => row.companyId),
		...journal.flatMap((row) => present(row.actorCompanyId))
	]);
	const companyOf = (id: string | null) => (id === null ? null : { id, name: names.get(id) ?? null });

	return {
		format: DATA_EXPORT_FORMAT,
		exported_at: now.toISOString(),
		account: {
			id: user.id,
			email: crypto.decrypt(user.emailEnc, 'users.email'),
			email_verified_at: iso(user.emailVerifiedAt),
			display_name: user.displayName,
			status: user.status,
			created_at: iso(user.createdAt),
			last_login_at: iso(user.lastLoginAt),
			deletion_requested_at: iso(user.deletionRequestedAt),
			password_changed_at: password === undefined ? null : iso(password.changedAt),
			sign_in_providers: identities.map((row) => ({
				issuer: row.issuer,
				subject: row.subject,
				link_method: row.linkMethod,
				linked_at: iso(row.linkedAt),
				last_login_at: iso(row.lastLoginAt),
				// What the provider said about the person at sign-in.
				profile_claims: row.profileClaims
			}))
		},
		athlete_links: athletes.map((row) => ({
			source: row.source,
			athlete_id: row.sourceAthleteId,
			resolution_method: row.resolutionMethod,
			status: row.status,
			linked_at: iso(row.linkedAt),
			unlinked_at: iso(row.unlinkedAt)
		})),
		notification_channels: channels.map((row) => ({
			kind: row.kind,
			status: row.status,
			// The chat id is kept only while the channel is active (domain 3.7); the email channel uses the account address.
			telegram_chat_id: decrypt(row.telegramChatIdEnc, 'notification_channels.telegram_chat_id'),
			linked_at: iso(row.linkedAt),
			unlinked_at: iso(row.unlinkedAt)
		})),
		notification_preferences: preferences.map((row) => ({
			category: row.category,
			channels: row.channels,
			updated_at: iso(row.updatedAt)
		})),
		profile: {
			id: candidate.id,
			status: candidate.status,
			last_name: decrypt(candidate.lastNameEnc, 'candidates.last_name'),
			first_name: decrypt(candidate.firstNameEnc, 'candidates.first_name'),
			middle_name: decrypt(candidate.middleNameEnc, 'candidates.middle_name'),
			phone: decrypt(candidate.phoneEnc, 'candidates.phone'),
			birth_date: candidate.birthDate,
			birth_date_precision: candidate.birthDatePrecision,
			birth_date_source: candidate.birthDateSource,
			birth_date_status: candidate.birthDateStatus,
			birth_date_verified_at: iso(candidate.birthDateVerifiedAt),
			eligible_from: candidate.eligibleFrom,
			visibility: candidate.visibility,
			search_status: candidate.searchStatus,
			headline: candidate.headline,
			desired_role_keys: candidate.desiredRoleKeys,
			preferences: candidate.preferences,
			purge_after: candidate.purgeAfter,
			created_at: iso(candidate.createdAt)
		},
		resumes: resumes.map((row) => ({
			id: row.id,
			seq: row.seq,
			is_current: row.isCurrent,
			parse_status: row.parseStatus,
			file_name: row.name,
			size_bytes: row.sizeBytes,
			uploaded_at: iso(row.uploadedAt),
			extractions: extractions
				.filter((extraction) => extraction.resumeDocumentId === row.id)
				.map((extraction) => ({
					extractor: { name: extraction.extractorName, version: extraction.extractorVersion },
					status: extraction.status,
					text: extraction.text,
					extracted_at: iso(extraction.createdAt)
				}))
		})),
		facts: facts.map((fact) => ({
			id: fact.id,
			source: fact.source,
			type: fact.factType,
			status: fact.status,
			status_reason: fact.statusReason,
			trust_level: fact.trustLevel,
			occurred_on: fact.occurredOn,
			observed_at: iso(fact.observedAt),
			payload: fact.payload,
			claims: factClaims
				.filter((claim) => claim.factId === fact.id)
				.map((claim) => ({
					type: claim.claimType,
					raw_text: claim.rawText,
					polarity: claim.polarity,
					skill_key: claim.skillKey,
					value: claim.value,
					your_review: claim.candidateReview,
					status: claim.status
				})),
			receipts: receipts
				.filter((receipt) => receipt.factId === fact.id)
				.map((receipt) => ({
					handle: receipt.handle,
					level: receipt.level,
					company: companyOf(receipt.audienceCompanyId),
					issued_at: iso(receipt.issuedAt)
				}))
		})),
		experience: experience.map((entry) => ({
			position_title: entry.positionTitle,
			role_key: entry.roleKey,
			organization: entry.organizationName,
			period_from: entry.periodFrom,
			period_to: entry.periodTo,
			is_current: entry.isCurrent,
			skill_keys: entry.appliedSkillKeys,
			your_review: entry.candidateReview,
			status: entry.status
		})),
		external_profiles: profiles.map((profile) => ({
			platform: profile.platform,
			handle: profile.handle,
			ownership: profile.ownershipStatus,
			verified_at: iso(profile.verifiedAt)
		})),
		surveys: surveys.map((survey) => ({
			id: survey.id,
			version: survey.version,
			catalog_version: survey.catalogVersion,
			direction: survey.direction,
			specialization: survey.specialization,
			declared_skill_keys: survey.declaredSkillKeys,
			preferences: survey.preferences,
			created_at: iso(survey.createdAt)
		})),
		grade_declarations: declarations.map((declaration) => ({
			id: declaration.id,
			survey_id: declaration.surveyId,
			specialization: declaration.specialization,
			grade: declaration.grade,
			hint: declaration.hint,
			declared_at: iso(declaration.declaredAt)
		})),
		evidence: runs.map(({ run, rulesetVersion }) => ({
			id: run.id,
			status: run.status,
			computed_at: iso(run.computedAt),
			as_of: iso(run.asOf),
			input_revision: run.inputRevision,
			input_refs: run.inputRefs,
			ruleset_version: rulesetVersion,
			experience: run.experienceSummary,
			fsp_levels: fspLevels
				.filter((level) => level.runId === run.id)
				.map((level) => ({
					discipline: level.discipline,
					level: level.level,
					basis_fact_ids: level.basisFactIds,
					last_result_on: level.lastResultOn
				})),
			skills: inferences
				.filter((inference) => inference.runId === run.id)
				.map((inference) => ({
					skill_key: inference.skillKey,
					strength: Number(inference.strength),
					band: inference.strengthBand,
					attestation: inference.attestation,
					badge_trust: inference.badgeTrust,
					contributions: inference.contributions
				}))
		})),
		categories: categories.map((category) => ({
			id: category.id,
			specialization: category.specialization,
			grade: category.grade,
			status: category.status,
			catalog_version: category.catalogVersion,
			decision_id: category.decisionId,
			bank_release_id: category.bankReleaseId,
			confirmed_blocks: category.confirmedBlocks,
			confirmed_skill_keys: category.confirmedSkillKeys,
			confident_upgrade_until: iso(category.confidentUpgradeUntil),
			assigned_at: iso(category.assignedAt),
			ended_at: iso(category.endedAt),
			revoke_reason: category.revokeReason
		})),
		// The operator who answered is named by role, never by account.
		objections: objections.map((objection) => ({
			id: objection.id,
			decision_id: objection.decisionId,
			reason: objection.reason,
			items: objection.items ?? [],
			status: objection.status,
			outcome: objection.outcome,
			opened_at: iso(objection.openedAt),
			due_at: iso(objection.dueAt),
			resolution: objection.resolution,
			resulting_decision_id: objection.resultingDecisionId,
			resolved_at: iso(objection.resolvedAt),
			notified_at: iso(objection.notifiedAt)
		})),
		company_blocks: blocks.map((block) => ({
			company: companyOf(block.companyId),
			blocked_at: iso(block.createdAt)
		})),
		matches: matches.map((row) => ({
			vacancy: {
				id: row.vacancyId,
				origin: row.vacancyOrigin,
				title: row.vacancyTitle,
				company: companyOf(row.vacancyCompanyId),
				organization: row.vacancyCompanyId === null ? organizationOf(row.vacancyExternalOrg) : null
			},
			score: Number(row.score),
			components: Object.fromEntries(COMPONENT_KEYS.map((key) => [key, storedComponent(row, key)])),
			vacancy_revision: row.vacancyRevision,
			profile_revision: row.candidateRevision,
			evidence_run_id: row.evidenceRunId,
			ruleset_version: row.rulesetVersion,
			computed_at: iso(row.computedAt)
		})),
		consents: consents.map((event) => ({
			kind: event.kind,
			action: event.action,
			signed_by: event.signerKind,
			document: { title: event.documentTitle, version: event.documentVersion },
			company: companyOf(event.scopeCompanyId),
			invitation_id: event.scopeInvitationId,
			competition: event.scopeCompetitionRef,
			fields: event.scopeFields,
			method: event.method,
			reason: event.reason,
			occurred_at: iso(event.occurredAt)
		})),
		document_acceptances: acceptances.map((row) => ({
			document: { kind: row.documentKind, title: row.documentTitle, version: row.documentVersion },
			company: companyOf(row.companyId),
			accepted_at: iso(row.acceptedAt),
			ip: row.ip,
			user_agent: row.ua
		})),
		representatives: representatives.map((row) => ({
			relation: row.relation,
			status: row.status,
			full_name: crypto.decrypt(row.fullNameEnc, 'legal_representatives.full_name'),
			email: crypto.decrypt(row.emailEnc, 'legal_representatives.email'),
			invited_at: iso(row.invitedAt),
			ended_at: iso(row.endedAt),
			end_reason: row.endReason,
			// The operator's checks of the representative's authority, the operator named by role.
			authority_checks: checks
				.filter((check) => check.representationId === row.id)
				.map((check) => ({
					method: check.method,
					basis_kind: check.basisKind,
					basis_note: check.basisNote,
					result: check.result,
					note: check.note,
					evidence_kept_until: check.evidenceRetentionUntil,
					checked_by: 'platform_staff',
					checked_at: iso(check.checkedAt)
				}))
		})),
		invitations: invited.map((invitation) => ({
			id: invitation.id,
			company: companyOf(invitation.companyId),
			status: invitation.status,
			sent_at: iso(invitation.sentAt),
			closed_at: iso(invitation.closedAt),
			terms: terms
				.filter((row) => row.invitationId === invitation.id)
				.map((row) => ({
					version: row.version,
					title: row.title,
					description: row.description,
					vacancy: row.vacancySnapshot,
					category: row.category,
					why_you: row.whyYou,
					work_format: row.workFormat,
					contact_method: row.contactMethod,
					salary: {
						min: row.salaryMin,
						max: row.salaryMax,
						currency: row.salaryCurrency,
						period: row.salaryPeriod,
						tax_base: row.salaryTaxBase
					},
					message: row.message,
					response_due_at: iso(row.responseDueAt),
					created_at: iso(row.createdAt)
				})),
			answers: responses
				.filter((row) => row.invitationId === invitation.id)
				.map((row) => ({
					decision: row.decision,
					reason_code: row.reasonCode,
					reason_text: row.reasonText,
					responded_at: iso(row.respondedAt)
				}))
		})),
		disclosures: handedOver.map((row) => ({
			company: companyOf(row.companyId),
			invitation_id: row.invitationId,
			fields: row.fields,
			channel: row.channel,
			disclosed_at: iso(row.disclosedAt)
		})),
		hiring: processes.map((process) => ({
			company: companyOf(process.companyId),
			invitation_id: process.invitationId,
			opened_at: iso(process.openedAt),
			reports: reports
				.filter((report) => report.processId === process.id)
				.map((report) => ({
					party: report.party,
					kind: report.kind,
					stage: report.stage,
					outcome: report.outcome,
					start_date: report.startDate,
					reason_code: report.reasonCode,
					reported_at: iso(report.reportedAt)
				}))
		})),
		tests: attempts.map((attempt) => {
			const running = attempt.status === 'started' && attempt.deadlineAt > now;
			return {
				title: attempt.title,
				version: attempt.version,
				status: attempt.status,
				started_at: iso(attempt.startedAt),
				deadline_at: iso(attempt.deadlineAt),
				submitted_at: iso(attempt.submittedAt),
				annul_reason: attempt.annulReason,
				integrity_signals: attempt.integritySignals,
				scores: scores
					.filter((score) => score.attemptId === attempt.id)
					.map((score) => ({
						score: Number(score.score),
						max_score: Number(score.maxScore),
						level: score.level,
						scored_by: score.scoredBy,
						review_reason: score.reviewReason,
						at: iso(score.createdAt)
					})),
				// Content past its retention period is cleared; the hash stays.
				artifacts: artifacts
					.filter((artifact) => artifact.attemptId === attempt.id)
					.map((artifact) => ({
						seq: artifact.seq,
						kind: artifact.kind,
						content: artifactContent(artifact.kind, artifact.content, running),
						sha256: artifact.sha256,
						created_at: iso(artifact.createdAt),
						kept_until: artifact.retentionUntil
					}))
			};
		}),
		notifications: received.map((row) => ({
			type: row.type,
			category: row.category,
			object: { type: row.objectType, id: row.objectId },
			payload: row.payload,
			created_at: iso(row.createdAt),
			read_at: iso(row.readAt),
			deliveries: deliveries
				.filter((delivery) => delivery.notificationId === row.id)
				.map((delivery) => ({
					channel: delivery.channelKind,
					status: delivery.status,
					skip_reason: delivery.skipReason,
					sent_at: iso(delivery.sentAt)
				}))
		})),
		journal: journal.map((row) => ({
			at: iso(row.occurredAt),
			action: row.action,
			outcome: row.outcome,
			// Who acted, by role: the candidate, a company by name, the platform; never another person's account.
			actor:
				row.actorUserId === userId
					? 'you'
					: row.actorCompanyId !== null
						? { company: names.get(row.actorCompanyId) ?? null }
						: row.actorKind === 'system'
							? 'platform'
							: row.actorKind === 'anonymous'
								? 'anonymous'
								: 'platform_staff',
			object: row.objectType === null ? null : { type: row.objectType, id: row.objectId },
			details: row.details
		}))
	};
}

/**
 * The candidate downloads their data: the document, and `data.exported` in the journal in the same transaction, so an
 * export is never given without its record.
 */
export async function exportOwnData(
	db: Database,
	crypto: FieldCrypto,
	input: {
		userId: string;
		candidateId: string;
		actor: AuditActor;
		requestId: string;
		ip: string | null;
		userAgent: string | null;
		channel: 'ui' | 'api';
	}
): Promise<DataExport> {
	return db.transaction(async (tx) => {
		const now = new Date();
		const document = await buildDataExport(tx, crypto, { userId: input.userId, candidateId: input.candidateId, now });
		await recordAuditEvent(tx, {
			action: 'data.exported',
			outcome: 'success',
			actor: input.actor,
			object: { type: 'candidate', id: input.candidateId },
			subjectCandidateId: input.candidateId,
			requestId: input.requestId,
			ip: input.ip,
			userAgent: input.userAgent,
			details: {
				format: DATA_EXPORT_FORMAT,
				channel: input.channel,
				facts: document.facts.length,
				consents: document.consents.length,
				journal: document.journal.length
			},
			occurredAt: now
		});
		return document;
	});
}
