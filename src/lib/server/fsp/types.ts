// Boundary of the FSP achievements adapter (docs/contracts.md, section 1): snapshot types, the access grant,
// webhook events and adapter errors. Field names follow `contracts/fsp-achievements/v1.schema.json`.
import type { Award } from '$lib/fsp/awards';

/** A value of a source enumeration the adapter could not map; the original string is kept in `rawValues`. */
export type Known<T extends string> = T | 'unknown';

export const DISCIPLINE_CODES = ['algorithmic', 'product', 'uas', 'robotics', 'infosec'] as const;
export type DisciplineCode = (typeof DISCIPLINE_CODES)[number];

export const COMPETITION_LEVELS = [
	'world_championship',
	'european_championship',
	'international_ekp',
	'russian_championship',
	'russian_cup',
	'russian_youth_championship',
	'all_russian_ekp',
	'all_russian_sport_event',
	'universiade',
	'federal_district',
	'interregional_ekp',
	'regional_championship',
	'regional_cup',
	'regional_youth',
	'regional_other',
	'municipal',
	'accredited',
	'unofficial'
] as const;
export type CompetitionLevel = (typeof COMPETITION_LEVELS)[number];

export const STAGES = ['qualifier', 'final', 'single'] as const;
type Stage = (typeof STAGES)[number];

export const AGE_GROUPS = ['boys_girls_u15', 'juniors_u19', 'juniors_u26', 'adults'] as const;
type AgeGroup = (typeof AGE_GROUPS)[number];

export const TEAM_ROLES = ['captain', 'athlete', 'reserve', 'trainer'] as const;
type TeamRole = (typeof TEAM_ROLES)[number];

export const EVSK_RANKS = ['MS', 'KMS', 'I', 'II', 'III', 'Y1', 'Y2', 'Y3'] as const;
export type EvskRank = (typeof EVSK_RANKS)[number];

export const QUALIFICATION_RANKS = ['ZMS', 'MSMK', ...EVSK_RANKS] as const;
type QualificationRank = (typeof QUALIFICATION_RANKS)[number];

export const RESULT_STATUSES = ['official', 'preliminary', 'annulled'] as const;
type ResultStatus = (typeof RESULT_STATUSES)[number];

export const WEBHOOK_EVENT_TYPES = [
	'result.published',
	'result.annulled',
	'qualification.assigned',
	'athlete.updated'
] as const;
type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface Discipline {
	code: DisciplineCode;
	name: string;
	vrvsCode: string;
	format: 'individual' | 'team' | 'both';
}

export interface Competition {
	id: string;
	ekpNumber: string | null;
	title: string;
	discipline: Known<DisciplineCode>;
	level: Known<CompetitionLevel>;
	stage?: Known<Stage>;
	ageGroup?: Known<AgeGroup>;
	format?: 'individual' | 'team';
	startDate: string;
	endDate?: string;
	location?: string;
	online?: boolean;
	platform?: string | null;
	participantsCount?: number;
	regionsCount?: number;
	protocolUrl?: string | null;
	rawValues?: Record<string, string>;
}

/**
 * Whether a result is a team's — the one rule for ranking, projection and every wording of it: the source names the team
 * or the competition is held in teams. A result of a team competition may come without the team (contracts 1.3); it is
 * still a team's, only unnamed.
 */
export function isTeamResult(namesTeam: boolean, format: Competition['format'] | null): boolean {
	return namesTeam || format === 'team';
}

export interface ResultTeam {
	id: string;
	name: string;
	region?: string;
	size?: number;
	role?: Known<TeamRole>;
	/** Absent or null — the source has no personal specialization. */
	specialization?: string | null;
}

export interface Result {
	id: string;
	competitionId: string;
	place: number | null;
	placeOf?: number;
	score?: number | null;
	solved?: number | null;
	penaltyMinutes?: number | null;
	team?: ResultTeam | null;
	award?: Known<Award>;
	/** The norm the source recorded as fulfilled; not an assigned rank. */
	evskFulfilled?: EvskRank | null;
	status: ResultStatus;
	publishedAt?: string;
	rawValues?: Record<string, string>;
}

export interface Qualification {
	id?: string;
	rank: Known<QualificationRank>;
	discipline?: Known<DisciplineCode>;
	assignedAt: string;
	validUntil?: string | null;
	orderNumber?: string | null;
	assignedBy?: string;
	basisCompetitionId?: string | null;
	rawValues?: Record<string, string>;
}

export interface NationalTeam {
	discipline: DisciplineCode;
	squad: 'main' | 'reserve';
	season: number;
}

export interface PlatformAccount {
	platform: string;
	login: string;
	rating?: number | null;
}

export interface Athlete {
	fspId: string;
	lastName: string;
	firstName: string;
	middleName?: string | null;
	birthYear?: number | null;
	region?: string;
	nationalTeam?: NationalTeam | null;
	platformAccounts?: PlatformAccount[];
}

export type IncompleteReason =
	'pagination_interrupted' | 'version_changed' | 'source_declared_partial' | 'no_completeness_signal';

export interface AchievementsSnapshot {
	athlete: Athlete;
	qualifications: Qualification[];
	results: Result[];
	competitions: Competition[];
	generatedAt: string;
	completeness: {
		complete: boolean;
		sourceVersion: string;
		pages: { fetched: number; total: number | null };
		incompleteReason?: IncompleteReason;
	};
}

export interface WebhookEvent {
	eventId: string;
	type: WebhookEventType;
	occurredAt: string;
	athleteIds: string[];
	competitionId?: string;
}

/** Per-call grant bound to one athlete and one consent (contracts 1.2). */
export type AccessGrant =
	| { kind: 'delegated_user_token'; accessToken: string; subject: string }
	| {
			kind: 'service_with_assertion';
			serviceToken: string;
			assertion: {
				sourceAthleteId: string;
				consentEventId: string;
				issuedAt: string;
				expiresAt: string;
				signature: string;
			};
	  };

export interface AdapterError<C extends string> {
	code: C;
	retryable: boolean;
	/** Without personal data. */
	message: string;
	details?: Record<string, unknown>;
}

export type AdapterResult<T, C extends string> = { ok: true; value: T } | { ok: false; error: AdapterError<C> };

export type FetchErrorCode =
	'not_found' | 'grant_invalid' | 'grant_mismatch' | 'unavailable' | 'rate_limited' | 'protocol_error';

export type WebhookErrorCode = 'signature_invalid' | 'timestamp_skew' | 'payload_invalid';

export interface ResolvedAthlete {
	sourceAthleteId: string;
	method: 'subject_equals_athlete_id' | 'resolved_by_source_api';
}

/** The adapter interface «by athlete» (contracts 1.1). */
export interface AchievementsSource {
	readonly source: 'fsp';
	readonly contractVersion: 'v1';
	resolveAthlete(input: {
		identity: { issuer: string; subject: string };
		grant: AccessGrant;
	}): Promise<AdapterResult<ResolvedAthlete, Exclude<FetchErrorCode, 'grant_mismatch'>>>;
	getAchievements(input: {
		sourceAthleteId: string;
		grant: AccessGrant;
	}): Promise<AdapterResult<AchievementsSnapshot, FetchErrorCode>>;
	listDisciplines(): Promise<AdapterResult<Discipline[], 'unavailable' | 'protocol_error'>>;
	getCompetition(id: string): Promise<AdapterResult<Competition, 'not_found' | 'unavailable' | 'protocol_error'>>;
	verifyWebhook(input: {
		headers: Record<string, string>;
		rawBody: Uint8Array;
	}): AdapterResult<WebhookEvent, WebhookErrorCode>;
}
