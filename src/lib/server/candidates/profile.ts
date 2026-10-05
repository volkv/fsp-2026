// The candidate's own profile (docs/domain.md, sections 9, 12, 14, projection `self`): every fact with where it came
// from and its receipt, and the skills of the evidence in force with their trust and the facts behind them. Evidence
// below the evidence floor is not shown as current: the profile is being recalculated (domain 17.3).
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { blockDefinition } from '$lib/server/assessments/contract/catalog';
import { testTitle } from '$lib/server/assessments/titles';
import type { Contribution } from '$lib/server/evidence/types';
import { parsePreferences, type CandidatePreferences } from '$lib/server/candidates/preferences';
import type { Executor } from '$lib/server/db';
import { publishedRun, runInForce } from '$lib/server/db/conditions';
import {
	athleteLinks,
	candidates,
	evidenceRuns,
	skillInferences,
	sourceFacts,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { fromSimulator, receiptStatementSchema, receiptStatus, type ReceiptStatus } from '$lib/server/fsp/receipts';
import type { Competition, NationalTeam, PlatformAccount, Qualification, Result } from '$lib/server/fsp/types';
import type { NamedKey } from '$lib/server/taxonomy/vocabulary';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import {
	candidateVocabularyOf,
	currentCandidateVocabulary,
	vocabularyLabels,
	type VocabularyLabels
} from './vocabulary';

function readableCandidate(subject: AccessSubject): string {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined) throw new ApiError('forbidden');
	const access = can(subject, 'candidate.self.read', { candidateId });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	return candidateId;
}

export type FactStatus = 'active' | 'superseded' | 'withdrawn' | 'annulled';
export type TrustLevel = 'fsp_verified' | 'platform_verified' | 'public_verifiable' | 'claimed';

/** The candidate's own receipt of a fact version; its status is computed now against the fact (domain 9.6). */
export interface SelfReceipt {
	handle: string;
	status: ReceiptStatus;
	verifiedAt: string;
	asserts: Record<string, string | number>;
	doesNotAssert: string[];
	signingKeyId: string;
	/** The statement says its source is the simulator of FSP on a demonstration stand (`source_simulator`). */
	simulator: boolean;
}

export type FactDetail =
	| {
			kind: 'competition_result';
			competition: string;
			discipline: string;
			level: string;
			stage: string | null;
			format: 'onsite' | 'online' | 'unknown';
			season: number;
			award: string;
			place: number | null;
			placeOf: number | null;
			team: { name: string; role: string | null; specialization: string | null } | null;
			evskIndicator: string | null;
			resultStatus: string;
			protocolUrl: string | null;
	  }
	| { kind: 'qualification'; discipline: string; rank: string; assignedAt: string }
	| { kind: 'national_team'; discipline: string; squad: 'main' | 'reserve'; season: number }
	| { kind: 'platform_rating'; platform: string; login: string; rating: number | null }
	| {
			kind: 'test_score';
			/** «Backend Junior»: the test on a declared grade that confirmed it. */
			title: string;
			attemptId: string;
			decisionId: string;
			/** Titles of the blocks passed. */
			blocks: string[];
			bankReleaseId: string;
			decidedOn: string;
	  }
	| {
			kind: 'test_block';
			/** «Блок-тест «API», Backend Middle»: the block confirmed at the request of an employer. */
			title: string;
			/** The skills the block covers: the area of the result. */
			skillKeys: string[];
			bankReleaseId: string;
			decidedOn: string;
	  }
	| { kind: 'other'; factType: string };

export interface SelfFact {
	id: string;
	source: 'fsp' | 'platform_test' | 'codeforces' | 'github' | 'resume';
	trustLevel: TrustLevel;
	/** How the fact is tied to the candidate (`ownership_basis`): the answer to «where did this come from». */
	ownershipBasis: string;
	status: FactStatus;
	statusReason: string | null;
	observedAt: Date;
	lastVerifiedAt: Date;
	occurredOn: string | null;
	detail: FactDetail;
	receipt: SelfReceipt | null;
	/** Skills of the evidence in force this fact contributes to. */
	supports: { skillKey: string; attestation: 'direct' | 'derived' | 'claimed' }[];
}

export interface SkillSource {
	factId: string;
	source: SelfFact['source'];
	trustLevel: TrustLevel;
	attestation: 'direct' | 'derived' | 'claimed';
	basis: Contribution['basis'];
	/** The field of the resume the contribution rests on: a mention of the skill, if any. */
	claimId: string | null;
	/** The experience entry of the resume the contribution rests on, if any. */
	experienceEntryId: string | null;
	/** The skill the contribution passed up from (a child skill), if any. */
	viaSkill: string | null;
	contribution: number;
}

export interface SelfSkill {
	skillKey: string;
	/** Weight of the grounds, 0…1; not a probability. */
	strength: number;
	band: 'weak' | 'moderate' | 'strong';
	attestation: 'direct' | 'derived' | 'claimed';
	badgeTrust: TrustLevel | null;
	sources: SkillSource[];
}

type RunState = 'available' | 'recalculating' | 'none';

interface CandidateHeader {
	displayName: string;
	searchStatus: 'active' | 'open_to_offers' | 'not_looking';
	visibility: 'hidden' | 'catalog';
	desiredRoleKeys: string[];
	preferences: CandidatePreferences;
	ageRegime: 'adult' | 'minor' | 'unknown';
}

async function candidateHeader(executor: Executor, candidateId: string, now: Date): Promise<CandidateHeader> {
	const [row] = await executor
		.select({
			displayName: users.displayName,
			searchStatus: candidates.searchStatus,
			visibility: candidates.visibility,
			desiredRoleKeys: candidates.desiredRoleKeys,
			preferences: candidates.preferences,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(eq(candidates.id, candidateId));
	if (!row) throw new ApiError('not_found');
	const band = ageBand({ birthDate: row.birthDate, precision: row.precision, status: row.birthStatus }, now);
	return {
		displayName: row.displayName ?? 'Без имени',
		searchStatus: row.searchStatus,
		visibility: row.visibility,
		desiredRoleKeys: row.desiredRoleKeys,
		preferences: parsePreferences(candidateId, row.preferences),
		ageRegime: band === 'adult' ? 'adult' : isMinorBand(band) ? 'minor' : 'unknown'
	};
}

/** The published evidence run while it is valid: at or above the evidence floor (domain 17.3). */
async function runInForceOf(executor: Executor, candidateId: string) {
	const [run] = await executor
		.select({
			id: evidenceRuns.id,
			inForce: runInForce(evidenceRuns, candidates),
			taxonomyVersionId: evidenceRuns.taxonomyVersionId,
			experienceSummary: evidenceRuns.experienceSummary
		})
		.from(evidenceRuns)
		.innerJoin(candidates, eq(candidates.id, evidenceRuns.candidateId))
		.where(and(eq(evidenceRuns.candidateId, candidateId), publishedRun(evidenceRuns)));
	if (!run) {
		const [blocked] = await executor
			.select({ id: evidenceRuns.id })
			.from(evidenceRuns)
			.where(and(eq(evidenceRuns.candidateId, candidateId), eq(evidenceRuns.status, 'blocked')))
			.limit(1);
		return { state: (blocked ? 'recalculating' : 'none') as RunState, run: null };
	}
	const { inForce, ...shown } = run;
	if (!inForce) return { state: 'recalculating' as RunState, run: null };
	return { state: 'available' as RunState, run: shown };
}

function formatOf(competition: Competition): 'onsite' | 'online' | 'unknown' {
	if (competition.online === undefined) return 'unknown';
	return competition.online ? 'online' : 'onsite';
}

/** What a `test_score` fact of the platform stores (assessments/engine, domain 10.9). */
interface TestScorePayload {
	decisionId: string;
	attemptId: string;
	specialization: string;
	grade: string;
	blocks: string[];
	bankReleaseId: string;
	decidedOn: string;
}

/** What a `test_block` fact stores (`confirmations/fact.ts`, domain 13.11). */
interface TestBlockPayload {
	specialization: string;
	block: string;
	grade: string;
	skillKeys: string[];
	bankReleaseId: string;
	decidedOn: string;
}

function detailOf(factType: string, payload: unknown): FactDetail {
	switch (factType) {
		case 'competition_result': {
			const { result, competition } = payload as { result: Result; competition: Competition };
			return {
				kind: 'competition_result',
				competition: competition.title,
				discipline: competition.discipline,
				level: competition.level,
				stage: competition.stage ?? null,
				format: formatOf(competition),
				season: Number(competition.startDate.slice(0, 4)),
				award: result.award ?? 'unknown',
				place: result.place,
				placeOf: result.placeOf ?? null,
				team: result.team
					? {
							name: result.team.name,
							role: result.team.role ?? null,
							specialization: result.team.specialization ?? null
						}
					: null,
				evskIndicator: result.evskFulfilled ?? null,
				resultStatus: result.status,
				protocolUrl: competition.protocolUrl ?? null
			};
		}
		case 'qualification': {
			const { qualification } = payload as { qualification: Qualification };
			return {
				kind: 'qualification',
				discipline: qualification.discipline ?? 'unknown',
				rank: qualification.rank,
				assignedAt: qualification.assignedAt
			};
		}
		case 'national_team': {
			const { nationalTeam } = payload as { nationalTeam: NationalTeam };
			return {
				kind: 'national_team',
				discipline: nationalTeam.discipline,
				squad: nationalTeam.squad,
				season: nationalTeam.season
			};
		}
		case 'platform_rating': {
			const { account } = payload as { account: PlatformAccount };
			return {
				kind: 'platform_rating',
				platform: account.platform,
				login: account.login,
				rating: account.rating ?? null
			};
		}
		case 'test_score': {
			const test = payload as TestScorePayload;
			return {
				kind: 'test_score',
				title: testTitle(test.specialization, test.grade),
				attemptId: test.attemptId,
				decisionId: test.decisionId,
				blocks: test.blocks.map((code) => blockDefinition(code).title),
				bankReleaseId: test.bankReleaseId,
				decidedOn: test.decidedOn
			};
		}
		case 'test_block': {
			const test = payload as TestBlockPayload;
			return {
				kind: 'test_block',
				title: `Блок-тест «${blockDefinition(test.block).title}», ${testTitle(test.specialization, test.grade)}`,
				skillKeys: test.skillKeys,
				bankReleaseId: test.bankReleaseId,
				decidedOn: test.decidedOn
			};
		}
		default:
			return { kind: 'other', factType };
	}
}

export interface SelfEvidence {
	displayName: string;
	ageRegime: CandidateHeader['ageRegime'];
	searchStatus: CandidateHeader['searchStatus'];
	visibility: CandidateHeader['visibility'];
	/** The FSP athlete is linked: achievements come by the import consent. */
	fspLinked: boolean;
	facts: SelfFact[];
	skills: SelfSkill[];
	/** Whether the skills come from a valid published evidence run. */
	skillsState: RunState;
	labels: VocabularyLabels;
}

/** Facts in force or annulled by their source: a superseded or withdrawn version is history, not the profile. */
const SHOWN_FACT_STATUSES = ['active', 'annulled'] as const;

export async function loadSelfEvidence(executor: Executor, subject: AccessSubject, now: Date): Promise<SelfEvidence> {
	const candidateId = readableCandidate(subject);
	const header = await candidateHeader(executor, candidateId, now);
	const { state, run } = await runInForceOf(executor, candidateId);
	const [link] = await executor
		.select({ id: athleteLinks.id })
		.from(athleteLinks)
		.innerJoin(candidates, eq(candidates.userId, athleteLinks.userId))
		.where(and(eq(candidates.id, candidateId), eq(athleteLinks.status, 'active')))
		.limit(1);

	const factRows = await executor
		.select({
			id: sourceFacts.id,
			source: sourceFacts.source,
			factType: sourceFacts.factType,
			trustLevel: sourceFacts.trustLevel,
			ownershipBasis: sourceFacts.ownershipBasis,
			payload: sourceFacts.payload,
			payloadSha256: sourceFacts.payloadSha256,
			status: sourceFacts.status,
			statusReason: sourceFacts.statusReason,
			observedAt: sourceFacts.observedAt,
			lastVerifiedAt: sourceFacts.lastVerifiedAt,
			occurredOn: sourceFacts.occurredOn
		})
		.from(sourceFacts)
		.where(and(eq(sourceFacts.candidateId, candidateId), inArray(sourceFacts.status, [...SHOWN_FACT_STATUSES])))
		.orderBy(desc(sourceFacts.occurredOn), desc(sourceFacts.observedAt));

	const receiptRows =
		factRows.length === 0
			? []
			: await executor
					.select({
						handle: verificationReceipts.handle,
						factId: verificationReceipts.factId,
						factPayloadSha256: verificationReceipts.factPayloadSha256,
						statement: verificationReceipts.statement,
						signingKeyId: verificationReceipts.signingKeyId,
						issuedAt: verificationReceipts.issuedAt
					})
					.from(verificationReceipts)
					.where(
						and(
							inArray(
								verificationReceipts.factId,
								factRows.map((fact) => fact.id)
							),
							// The candidate's own receipts: issued for no company.
							isNull(verificationReceipts.audienceCompanyId),
							eq(verificationReceipts.disclosureLevel, 'generalized')
						)
					)
					.orderBy(desc(verificationReceipts.issuedAt));

	const inferences = run
		? await executor
				.select({
					skillKey: skillInferences.skillKey,
					strength: skillInferences.strength,
					band: skillInferences.strengthBand,
					attestation: skillInferences.attestation,
					badgeTrust: skillInferences.badgeTrust,
					contributions: skillInferences.contributions
				})
				.from(skillInferences)
				.where(eq(skillInferences.runId, run.id))
		: [];

	const skills: SelfSkill[] = inferences
		.map((row) => ({
			skillKey: row.skillKey,
			strength: Number(row.strength),
			band: row.band,
			attestation: row.attestation,
			badgeTrust: row.badgeTrust,
			sources: (row.contributions as Contribution[]).map((c) => ({
				factId: c.fact_id,
				source: c.source,
				trustLevel: c.trust_level,
				attestation: c.attestation,
				basis: c.basis,
				claimId: c.claim_id,
				experienceEntryId: c.experience_entry_id,
				viaSkill: c.via_skill,
				contribution: c.contribution
			}))
		}))
		.sort((a, b) => b.strength - a.strength || a.skillKey.localeCompare(b.skillKey));

	const facts: SelfFact[] = factRows.map((fact) => {
		const receipt = receiptRows.find((row) => row.factId === fact.id);
		const statement = receipt && receiptStatementSchema.parse(receipt.statement);
		return {
			id: fact.id,
			source: fact.source,
			trustLevel: fact.trustLevel,
			ownershipBasis: fact.ownershipBasis,
			status: fact.status,
			statusReason: fact.statusReason,
			observedAt: fact.observedAt,
			lastVerifiedAt: fact.lastVerifiedAt,
			occurredOn: fact.occurredOn,
			detail: detailOf(fact.factType, fact.payload),
			receipt:
				receipt && statement
					? {
							handle: receipt.handle,
							status: receiptStatus(fact.status, fact.payloadSha256 === receipt.factPayloadSha256),
							verifiedAt: statement.verified_at,
							asserts: statement.asserts,
							doesNotAssert: statement.does_not_assert,
							signingKeyId: receipt.signingKeyId,
							simulator: fromSimulator(statement)
						}
					: null,
			supports: skills.flatMap((skill) => {
				const source = skill.sources.find((s) => s.factId === fact.id && s.viaSkill === null);
				return source ? [{ skillKey: skill.skillKey, attestation: source.attestation }] : [];
			})
		};
	});

	const vocabulary = run
		? await candidateVocabularyOf(executor, run.taxonomyVersionId)
		: await currentCandidateVocabulary(executor);
	return {
		displayName: header.displayName,
		ageRegime: header.ageRegime,
		searchStatus: header.searchStatus,
		visibility: header.visibility,
		fspLinked: link !== undefined,
		facts,
		skills,
		skillsState: state,
		labels: vocabularyLabels(vocabulary)
	};
}

export interface SelfSettings {
	searchStatus: CandidateHeader['searchStatus'];
	desiredRoleKeys: string[];
	preferences: CandidatePreferences;
	options: { roles: NamedKey[]; workFormats: NamedKey[]; employmentForms: NamedKey[] };
}

/** What the candidate states about the search, with the taxonomy options of the form. */
export async function loadSelfSettings(executor: Executor, subject: AccessSubject, now: Date): Promise<SelfSettings> {
	const candidateId = readableCandidate(subject);
	const header = await candidateHeader(executor, candidateId, now);
	const vocabulary = await currentCandidateVocabulary(executor);
	return {
		searchStatus: header.searchStatus,
		desiredRoleKeys: header.desiredRoleKeys,
		preferences: header.preferences,
		options: {
			roles: vocabulary?.roles ?? [],
			workFormats: vocabulary?.workFormats ?? [],
			employmentForms: vocabulary?.employmentForms ?? []
		}
	};
}
