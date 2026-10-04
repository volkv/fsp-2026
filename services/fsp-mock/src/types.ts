// Shapes of the achievements API (contract fsp-achievements/v1, JSON Schema in contracts/fsp-achievements/v1.schema.json).

export type Known<T extends string> = T | 'unknown';

export const DISCIPLINE_CODES = ['algorithmic', 'product', 'uas', 'robotics', 'infosec'] as const;
export type DisciplineCode = (typeof DISCIPLINE_CODES)[number];

export type CompetitionLevel =
	| 'world_championship'
	| 'european_championship'
	| 'international_ekp'
	| 'russian_championship'
	| 'russian_cup'
	| 'russian_youth_championship'
	| 'all_russian_ekp'
	| 'all_russian_sport_event'
	| 'universiade'
	| 'federal_district'
	| 'interregional_ekp'
	| 'regional_championship'
	| 'regional_cup'
	| 'regional_youth'
	| 'regional_other'
	| 'municipal'
	| 'accredited'
	| 'unofficial';

export type Stage = 'qualifier' | 'final' | 'single';
export type AgeGroup = 'boys_girls_u15' | 'juniors_u19' | 'juniors_u26' | 'adults';
export type TeamRole = 'captain' | 'athlete' | 'reserve' | 'trainer';
export type Award = 'winner' | 'prize' | 'finalist' | 'participant';
export type EvskRank = 'MS' | 'KMS' | 'I' | 'II' | 'III' | 'Y1' | 'Y2' | 'Y3';
export type QualificationRank = 'ZMS' | 'MSMK' | EvskRank;
export type ResultStatus = 'official' | 'preliminary' | 'annulled';

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

export interface ResultTeam {
	id: string;
	name: string;
	region?: string;
	size?: number;
	role?: Known<TeamRole>;
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
	nationalTeam?: { discipline: DisciplineCode; squad: 'main' | 'reserve'; season: number } | null;
	platformAccounts?: PlatformAccount[];
}

export type WebhookEventType = 'result.published' | 'result.annulled' | 'qualification.assigned' | 'athlete.updated';

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
	'result.published',
	'result.annulled',
	'qualification.assigned',
	'athlete.updated'
];

export interface WebhookEvent {
	eventId: string;
	type: WebhookEventType;
	occurredAt: string;
	athleteIds: string[];
	competitionId?: string;
}

/** One page of `GET /v1/athletes/{fspId}/achievements`. */
export interface AchievementsPage {
	athlete: Athlete;
	qualifications: Qualification[];
	results: Result[];
	competitions: Competition[];
	generatedAt: string;
	sourceVersion: string;
	page: { number: number; size: number; totalPages: number; totalResults: number };
	/** Present unless the source withholds the completeness signal; `false` — the source declares the data partial. */
	complete?: boolean;
}

export type ApiErrorCode =
	| 'not_found'
	| 'grant_invalid'
	| 'grant_mismatch'
	| 'unavailable'
	| 'rate_limited'
	| 'invalid_request'
	| 'unauthorized';

export interface ApiErrorBody {
	error: { code: ApiErrorCode; message: string };
}
