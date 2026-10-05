// The candidate card of the employer catalog (docs/domain.md, sections 9, 12, 14): found by the pseudonym of the company
// with the same checks and `canShow` as the list, read from the categories in force, the valid evidence run and the
// active facts, and cut by `projectCandidate` to the catalog projection. Fact ids never leave this module: a company sees
// categories, skills, achievements and the receipts issued for it, linked to the achievements by the receipt handles.
// The card is the one DTO of the company's view: the pages serialize it as is, the API renames its fields.
import { and, eq, inArray } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { experienceMonths } from '$lib/server/evidence/experience';
import type { ExperienceSummary } from '$lib/server/evidence/types';
import { parsePreferences } from '$lib/server/candidates/preferences';
import { activeCategories, categoryViews } from '$lib/server/categories/read';
import { auditActorOf } from '$lib/server/companies/context';
import type { Executor } from '$lib/server/db';
import { listedInCatalog, publishedRun, runInForce } from '$lib/server/db/conditions';
import {
	candidates,
	evidenceRuns,
	experienceEntries,
	externalProfiles,
	fspLevelAssignments,
	skillInferences,
	sourceFacts,
	verificationReceipts
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import {
	fromSimulator,
	issueCompanyReceipts,
	loadReceiptTemplates,
	receiptStatementSchema,
	receiptStatus,
	type ReceiptSigner,
	type ReceiptStatus
} from '$lib/server/fsp/receipts';
import type { Competition, Result } from '$lib/server/fsp/types';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { scoreCandidatesForVacancy } from '$lib/server/matching/rank';
import { loadActiveMatchRuleset } from '$lib/server/matching/ruleset';
import { companyExplanation, companyVacancy, type CompanyMatch } from '$lib/server/matching/search';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { regionName } from '$lib/server/regions';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { canShow, type ShowExtra } from '$lib/server/visibility/can-show';
import {
	catalogExactFacts,
	projectCandidate,
	type CandidateCard,
	type CandidateCardSource,
	type FspAchievement
} from '$lib/server/visibility/projections';

/** A candidate the company sees in the catalog, as the list shows them; the id never leaves the server. */
export interface CatalogCandidate {
	candidateId: string;
	pseudonym: string;
	projection: 'catalog';
	extras: ShowExtra[];
	/** With a vacancy: the match of the pair, explained without internal fact ids; without one: `null`. */
	match: CompanyMatch | null;
}

/**
 * The candidate of a pseudonym in the catalog of the subject's company, with the match for the vacancy when one is
 * given; `null` — the company does not see such a candidate (in this vacancy context) right now. The same checks as
 * the catalog search — `catalog.search`, the viewer, an own open vacancy as the context, `canShow` over the same facts —
 * for this one candidate, and `matchScore` of this one pair with the semantic and reranker components.
 */
export async function findInCatalog(
	deps: MatchingDeps,
	subject: AccessSubject,
	pseudonym: string,
	vacancyId: string | undefined,
	signal?: AbortSignal
): Promise<CatalogCandidate | null> {
	const decision = can(subject, 'catalog.search', null);
	if (!decision.allowed) throw new ApiError(decision.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	const { db: executor } = deps;
	const now = deps.now();
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer) throw new ApiError('forbidden');
	const companyId = viewer.viewer.companyId;
	const vacancy = vacancyId === undefined ? null : await companyVacancy(executor, vacancyId, companyId);

	// A pseudonym is a keyed hash of the id for the company: it is found among the candidates the catalog may list,
	// and `canShow` below decides whether this company sees the one found.
	const listed = await executor.select({ id: candidates.id }).from(candidates).where(listedInCatalog(candidates));
	const candidateId = listed.find((row) => deps.pseudonym(row.id, companyId) === pseudonym)?.id;
	if (candidateId === undefined) return null;

	const facts = (
		await loadVisibilityFacts(executor, [candidateId], {
			now,
			policy: await loadVisibilityPolicy(executor, now),
			viewerCompanyId: companyId,
			viewerCompany: viewer.company,
			...(vacancy
				? {
						vacancy: {
							id: vacancy.id,
							companyId: vacancy.companyId,
							origin: vacancy.origin,
							status: vacancy.status,
							minAge: vacancy.minAge
						}
					}
				: {})
		})
	).get(candidateId);
	if (!facts) return null;
	const show = canShow(
		facts,
		viewer.viewer,
		vacancy ? { kind: 'catalog', vacancyId: vacancy.id } : { kind: 'catalog' }
	);
	if (!show.allowed || show.projection !== 'catalog') return null;

	let match: CompanyMatch | null = null;
	if (vacancy) {
		// The pair is scored alone, so the reranker scores it too: in the list only the first candidates by score are
		// reranked, and one outside of them gets here the reranker component the list leaves unavailable.
		const scoring = await scoreCandidatesForVacancy(executor, deps.models, vacancy, [candidateId], {
			ruleset: await loadActiveMatchRuleset(executor),
			priority: 'interactive',
			...(signal ? { signal } : {})
		});
		const [scored] = scoring.ranked;
		if (!scored) throw new Error(`candidate ${candidateId} of a catalog decision has no snapshot`);
		match = {
			score: scored.result.score,
			coverage: scored.result.coverage,
			components: scored.result.components,
			explanation: companyExplanation(scored.result.explanation)
		};
	}
	return { candidateId, pseudonym, projection: 'catalog', extras: show.extras, match };
}

/** A receipt of the company's audience as the card shows it; its status is computed when the card is read. */
export interface CardReceipt {
	handle: string;
	level: 'generalized' | 'exact';
	status: ReceiptStatus;
	verifiedAt: string;
	asserts: Record<string, string | number>;
	doesNotAssert: string[];
	signingKeyId: string;
	/** The statement says its source is the simulator of FSP on a demonstration stand (`source_simulator`). */
	simulator: boolean;
}

export interface EmployerCard {
	card: CandidateCard;
	/** The evidence run is valid, below the evidence floor (being recalculated) or absent. */
	evidenceState: 'available' | 'recalculating' | 'none';
	receipts: CardReceipt[];
}

function competitionAchievement(factId: string, payload: { result: Result; competition: Competition }): FspAchievement {
	const { result, competition } = payload;
	return {
		factId,
		generalized: {
			discipline: competition.discipline,
			competitionLevel: competition.level,
			season: Number(competition.startDate.slice(0, 4)),
			resultGroup: result.award ?? 'unknown',
			format: competition.online === undefined ? 'unknown' : competition.online ? 'online' : 'onsite',
			computedIndicator: result.evskFulfilled ?? null
		},
		exact: {
			competitionRef: competition.id,
			competitionTitle: competition.title,
			stage: competition.stage ?? null,
			place: result.place,
			team: result.team ? { name: result.team.name, role: result.team.role ?? null } : null,
			protocolUrl: competition.protocolUrl ?? null
		}
	};
}

/**
 * The catalog card of a candidate the company sees, by the decision `canShow` gave in the search. Personal fields are
 * not read: the catalog projection never shows them. Education and assessments are not read either — the employer
 * card does not show them.
 */
export async function loadCatalogCard(
	executor: Executor,
	input: {
		candidateId: string;
		companyId: string;
		pseudonym: string;
		extras: readonly ShowExtra[];
		/** The competition of the partner pool the card is shown in: its result is exact (`partner_competition_result`). */
		partnerCompetitionRef?: string;
		now: Date;
		/** Signs the receipts issued for the company on this view. */
		signer: ReceiptSigner;
	}
): Promise<EmployerCard> {
	const { candidateId, now } = input;
	const [candidate] = await executor
		.select({
			preferences: candidates.preferences,
			desiredRoleKeys: candidates.desiredRoleKeys,
			searchStatus: candidates.searchStatus,
			birthDate: candidates.birthDate,
			birthDatePrecision: candidates.birthDatePrecision,
			birthDateStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate) throw new Error(`candidate ${candidateId} of a catalog decision does not exist`);
	const preferences = parsePreferences(candidateId, candidate.preferences);
	const band = ageBand(
		{ birthDate: candidate.birthDate, precision: candidate.birthDatePrecision, status: candidate.birthDateStatus },
		now
	);

	const [run] = await executor
		.select({
			id: evidenceRuns.id,
			inForce: runInForce(evidenceRuns, candidates),
			experienceSummary: evidenceRuns.experienceSummary
		})
		.from(evidenceRuns)
		.innerJoin(candidates, eq(candidates.id, evidenceRuns.candidateId))
		.where(and(eq(evidenceRuns.candidateId, candidateId), publishedRun(evidenceRuns)));
	const validRun = run?.inForce ? run : null;
	const categories = categoryViews((await activeCategories(executor, [candidateId])).get(candidateId) ?? []);

	let skills: CandidateCardSource['skills'] = [];
	let fspLevels: CandidateCardSource['fspLevels'] = [];
	let experienceSummary: CandidateCardSource['experienceSummary'] = null;
	if (validRun) {
		const [inferences, levels] = await Promise.all([
			executor
				.select({
					skillKey: skillInferences.skillKey,
					strengthBand: skillInferences.strengthBand,
					attestation: skillInferences.attestation,
					badgeTrust: skillInferences.badgeTrust
				})
				.from(skillInferences)
				.where(eq(skillInferences.runId, validRun.id)),
			executor
				.select({
					discipline: fspLevelAssignments.discipline,
					level: fspLevelAssignments.level,
					lastResultOn: fspLevelAssignments.lastResultOn
				})
				.from(fspLevelAssignments)
				.where(eq(fspLevelAssignments.runId, validRun.id))
		]);
		skills = inferences.sort((a, b) => a.skillKey.localeCompare(b.skillKey));
		fspLevels = levels;
		const summary = validRun.experienceSummary as ExperienceSummary;
		experienceSummary = {
			total: { minMonths: summary.total.min_months, maxMonths: summary.total.max_months },
			byRole: Object.fromEntries(
				Object.entries(summary.by_role).map(([role, range]) => [
					role,
					{ minMonths: range.min_months, maxMonths: range.max_months }
				])
			)
		};
	}

	const facts = await executor
		.select({ id: sourceFacts.id, payload: sourceFacts.payload, payloadSha256: sourceFacts.payloadSha256 })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, candidateId),
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.factType, 'competition_result'),
				eq(sourceFacts.status, 'active')
			)
		);
	const fspAchievements = facts
		.map((fact) => competitionAchievement(fact.id, fact.payload as { result: Result; competition: Competition }))
		.sort((a, b) => b.generalized.season - a.generalized.season);

	const entries = await executor
		.select()
		.from(experienceEntries)
		.where(and(eq(experienceEntries.candidateId, candidateId), eq(experienceEntries.status, 'active')));
	const experience = entries.flatMap((entry) => {
		if (entry.candidateReview === 'rejected') return [];
		const duration =
			entry.periodStatus === 'valid'
				? experienceMonths([{ ...entry, candidateReview: entry.candidateReview }], now)
				: null;
		return [
			{
				roleKey: entry.roleKey,
				positionTitle: entry.positionTitle,
				organizationName: entry.organizationName,
				periodFrom: entry.periodFrom,
				periodTo: entry.periodTo,
				isCurrent: entry.isCurrent,
				duration: duration && { minMonths: duration.min_months, maxMonths: duration.max_months },
				appliedSkillKeys: entry.appliedSkillKeys
			}
		];
	});

	const profiles = await executor
		.select({
			platform: externalProfiles.platform,
			handle: externalProfiles.handle,
			ownershipStatus: externalProfiles.ownershipStatus
		})
		.from(externalProfiles)
		.where(eq(externalProfiles.candidateId, candidateId));

	const salary = preferences.salary_expectation;
	const region = preferences.region_code ?? null;
	const source: CandidateCardSource = {
		candidateId,
		fullName: { last: null, first: null, middle: null },
		email: null,
		phone: null,
		birthDate: null,
		isMinor: isMinorBand(band),
		city: null,
		region,
		regionName: region === null ? null : await regionName(region),
		preferences: {
			workFormats: preferences.work_formats ?? [],
			employmentForms: preferences.employment_forms ?? [],
			relocation: preferences.relocation ?? null,
			searchStatus: candidate.searchStatus,
			salaryExpectation: salary
				? {
						min: salary.min,
						max: salary.max,
						currency: salary.currency,
						period: salary.period,
						taxBase: salary.tax_base
					}
				: null
		},
		categories,
		desiredRoleKeys: candidate.desiredRoleKeys,
		fspLevels,
		skills,
		fspAchievements,
		receipts: [],
		experience,
		experienceSummary,
		education: [],
		assessments: [],
		externalProfiles: profiles.map((profile) => ({
			platform: profile.platform,
			handle: profile.handle,
			verified: profile.ownershipStatus === 'verified'
		})),
		resumeFileId: null,
		disclosures: []
	};
	// The catalog shows every active fact, generalized or exactly as the projection decides; the receipts follow it.
	const pool = input.partnerCompetitionRef === undefined ? {} : { partnerCompetitionRef: input.partnerCompetitionRef };
	const shown = {
		factIds: fspAchievements.map((achievement) => achievement.factId),
		exactFactIds: [...catalogExactFacts(source, input.extras, pool)]
	};
	// Ages 14–17: the catalog shows only discipline and competition level (domain 14), while a generalized receipt
	// asserts season, result group and format as well — no receipts are issued or shown for them.
	const receiptRows = source.isMinor || shown.factIds.length === 0 ? [] : await companyReceipts(executor, input, shown);
	const currentSha = new Map(facts.map((fact) => [fact.id, fact.payloadSha256]));
	const card = projectCandidate(
		{ ...source, receipts: receiptRows.map((row) => ({ factId: row.factId, level: row.level, handle: row.handle })) },
		{ projection: 'catalog', extras: input.extras },
		{ pseudonym: input.pseudonym, ...pool }
	);
	const shownHandles = new Set((card.receipts ?? []).map((receipt) => receipt.handle));
	return {
		card,
		evidenceState: validRun ? 'available' : run ? 'recalculating' : 'none',
		receipts: receiptRows
			.filter((row) => shownHandles.has(row.handle))
			.map((row) => {
				const statement = receiptStatementSchema.parse(row.statement);
				return {
					handle: row.handle,
					level: row.level,
					// The facts read above are active: a receipt of an earlier version of one is superseded.
					status: receiptStatus('active', currentSha.get(row.factId) === row.factPayloadSha256),
					verifiedAt: statement.verified_at,
					asserts: statement.asserts,
					doesNotAssert: statement.does_not_assert,
					signingKeyId: row.signingKeyId,
					simulator: fromSimulator(statement)
				};
			})
	};
}

/**
 * Issues the company's receipts of the facts its card shows (a repeated view finds them issued) and reads every
 * receipt of those facts issued for the company, earlier versions included.
 */
async function companyReceipts(
	executor: Executor,
	input: { candidateId: string; companyId: string; signer: ReceiptSigner },
	shown: { factIds: string[]; exactFactIds: string[] }
) {
	const { factIds } = shown;
	await issueCompanyReceipts(executor, input.signer, await loadReceiptTemplates(executor), {
		companyId: input.companyId,
		candidateId: input.candidateId,
		factIds,
		exactFactIds: shown.exactFactIds
	});
	return executor
		.select({
			handle: verificationReceipts.handle,
			factId: verificationReceipts.factId,
			level: verificationReceipts.disclosureLevel,
			factPayloadSha256: verificationReceipts.factPayloadSha256,
			statement: verificationReceipts.statement,
			signingKeyId: verificationReceipts.signingKeyId
		})
		.from(verificationReceipts)
		.where(
			and(inArray(verificationReceipts.factId, factIds), eq(verificationReceipts.audienceCompanyId, input.companyId))
		);
}

/**
 * Journals that a member of the company opened the catalog card (and the match for a vacancy): access to a candidate's
 * data is recorded with the pseudonym the company knows (domain 18).
 */
export async function journalCardView(
	executor: Executor,
	subject: AccessSubject,
	meta: RequestMeta,
	view: { candidateId: string; pseudonym: string; vacancyId: string | null }
): Promise<void> {
	const common = {
		outcome: 'success' as const,
		actor: auditActorOf(subject),
		subjectCandidateId: view.candidateId,
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent
	};
	await recordAuditEvent(executor, {
		...common,
		action: 'card.viewed',
		details: { pseudonym: view.pseudonym, projection: 'catalog' }
	});
	if (view.vacancyId !== null) {
		await recordAuditEvent(executor, {
			...common,
			action: 'match.viewed',
			object: { type: 'vacancy', id: view.vacancyId },
			details: { pseudonym: view.pseudonym, vacancy_id: view.vacancyId }
		});
	}
}
