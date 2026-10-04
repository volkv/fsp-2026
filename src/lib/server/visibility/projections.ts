// Projections of the candidate card (docs/domain.md, section 14): one data model, five field sets.
// The interface, the API and exports use these functions; the projection itself is chosen by `canShow`. Fact ids are
// the source's keys only: a card links an achievement to its receipts by the receipt handles, which are issued per
// audience, so the same fact in the cards of two viewers carries nothing in common.
import type { Award } from '$lib/fsp/awards';
import type { DisclosureField, PublicScopeField } from '$lib/server/consent/kinds';
import type { Projection, ShowExtra } from './can-show';

export interface SalaryRange {
	min: number | null;
	max: number | null;
	currency: string;
	period: 'month' | 'year' | 'hour' | 'project';
	taxBase: 'gross' | 'net' | 'unknown';
}

export interface MonthsRange {
	minMonths: number;
	maxMonths: number;
}

export interface CategoryView {
	rank: 'primary' | 'secondary';
	role: { status: 'established'; key: string } | { status: 'insufficient_data' };
	grade: { status: 'established'; min: string; max: string } | { status: 'insufficient_data' };
	stack: { status: 'established'; skillKeys: string[] } | { status: 'insufficient_data' };
	explanation: unknown;
}

export interface FspAchievement {
	factId: string;
	/** Always shown in the catalog: no competition, stage, place or team (domain 14). */
	generalized: {
		discipline: string;
		competitionLevel: string;
		season: number;
		resultGroup: Award | 'unknown';
		format: 'onsite' | 'online' | 'unknown';
		computedIndicator: string | null;
	};
	exact: {
		competitionRef: string;
		competitionTitle: string;
		stage: string | null;
		place: number | null;
		team: { name: string; role: string | null } | null;
		protocolUrl: string | null;
	};
}

/** A receipt the source holds for the viewer, keyed by its fact. */
export interface ReceiptView {
	factId: string;
	level: 'generalized' | 'exact';
	handle: string;
}

/** A receipt as a card shows it: without the fact behind it. */
export interface CardReceiptRef {
	level: 'generalized' | 'exact';
	handle: string;
}

export interface ExperienceView {
	roleKey: string | null;
	positionTitle: string | null;
	organizationName: string | null;
	periodFrom: string | null;
	periodTo: string | null;
	isCurrent: boolean;
	duration: MonthsRange | null;
	appliedSkillKeys: string[];
}

export interface EducationView {
	level: string;
	field: string | null;
	institution: string | null;
	graduationYear: number | null;
}

export interface AssessmentView {
	title: string;
	version: number;
	scoredOn: string;
	level: string;
	skillKeys: string[];
	coverage: unknown;
	/** Attempts, answers and code; the candidate and the operator only (domain 10.4). */
	attempts: unknown;
}

export interface ExternalProfileView {
	platform: 'codeforces' | 'github';
	handle: string;
	verified: boolean;
}

/** Everything the platform holds about a candidate that a card may show. */
export interface CandidateCardSource {
	candidateId: string;
	fullName: { last: string | null; first: string | null; middle: string | null };
	email: string | null;
	phone: string | null;
	birthDate: string | null;
	isMinor: boolean;
	city: string | null;
	/** Code of the region from the reference of regions (`preferences.region_code`). */
	region: string | null;
	/** Name of `region` in the same reference; `null` exactly when `region` is. */
	regionName: string | null;
	preferences: {
		workFormats: string[];
		employmentForms: string[];
		relocation: boolean | null;
		searchStatus: 'active' | 'open_to_offers' | 'not_looking';
		salaryExpectation: SalaryRange | null;
	};
	categories: CategoryView[];
	/** What is missing per axis and how to add it (`categorization_runs.missing`). */
	categoryMissing: unknown;
	desiredRoleKeys: string[];
	fspLevels: { discipline: string; level: string; lastResultOn: string | null }[];
	skills: {
		skillKey: string;
		strengthBand: 'weak' | 'moderate' | 'strong';
		attestation: 'direct' | 'derived' | 'claimed';
		badgeTrust: string | null;
	}[];
	fspAchievements: FspAchievement[];
	/** Receipts issued for the viewer (own receipts for the candidate, the company's receipts for a company). */
	receipts: ReceiptView[];
	experience: ExperienceView[];
	experienceSummary: { total: MonthsRange; byRole: Record<string, MonthsRange> } | null;
	education: EducationView[];
	assessments: AssessmentView[];
	externalProfiles: ExternalProfileView[];
	resumeFileId: string | null;
	disclosures: { companyId: string; fields: string[]; disclosedAt: string; consentEventId: string }[];
}

/** An achievement of a card with the handles of its receipts shown in the same card. */
export type CardAchievement =
	| { generalized: Partial<FspAchievement['generalized']>; receiptHandles: string[] }
	| { generalized: FspAchievement['generalized']; exact: FspAchievement['exact']; receiptHandles: string[] };

/** A card; blocks that the projection does not include are absent. */
export interface CandidateCard {
	projection: Projection;
	candidateId?: string;
	pseudonym?: string;
	fullName?: CandidateCardSource['fullName'];
	email?: string | null;
	phone?: string | null;
	birthDate?: string | null;
	isMinor?: boolean;
	city?: string | null;
	region?: string | null;
	regionName?: string | null;
	preferences?: CandidateCardSource['preferences'];
	categories?: CategoryView[];
	categoryMissing?: unknown;
	desiredRoleKeys?: string[];
	fspLevels?: CandidateCardSource['fspLevels'];
	skills?: CandidateCardSource['skills'];
	fspAchievements?: CardAchievement[];
	receipts?: CardReceiptRef[];
	experience?: Partial<ExperienceView>[];
	experienceSummary?: CandidateCardSource['experienceSummary'];
	education?: Partial<EducationView>[];
	assessments?: Partial<AssessmentView>[];
	externalProfiles?: ExternalProfileView[];
	resumeFileId?: string | null;
	disclosures?: CandidateCardSource['disclosures'];
}

export interface ProjectionContext {
	/** Pseudonym of the candidate for the viewing company (catalog and recipient). */
	pseudonym?: string;
	/** Fields of the effective `contact_disclosure` consent of the invitation (recipient). */
	disclosedFields?: readonly DisclosureField[];
	/** Competition of the partner pool: its result is shown exactly (`partner_competition_result`). */
	partnerCompetitionRef?: string;
	/** Blocks the adult chose for the public page. */
	publicFields?: readonly PublicScopeField[];
	/** What the operator's case needs beyond the default operator view. */
	operatorNeeds?: ReadonlySet<'contacts' | 'birth_date' | 'resume'>;
}

function required<T>(value: T | undefined, name: string, projection: Projection): T {
	if (value === undefined) throw new Error(`projection ${projection} needs ${name}`);
	return value;
}

/** The receipts a card shows, without their facts; each achievement refers to its own by the handles. */
function shownReceipts(receipts: readonly ReceiptView[]) {
	return {
		receipts: receipts.map(({ level, handle }): CardReceiptRef => ({ level, handle })),
		handlesOf: (achievement: FspAchievement) =>
			receipts.filter((receipt) => receipt.factId === achievement.factId).map((receipt) => receipt.handle)
	};
}

function exactAchievement(achievement: FspAchievement, handles: string[]): CardAchievement {
	return { generalized: achievement.generalized, exact: achievement.exact, receiptHandles: handles };
}

function catalogAchievement(achievement: FspAchievement, isMinor: boolean, handles: string[]): CardAchievement {
	// Ages 14–17 see only discipline and competition level (domain 14).
	const generalized = isMinor
		? { discipline: achievement.generalized.discipline, competitionLevel: achievement.generalized.competitionLevel }
		: achievement.generalized;
	return { generalized, receiptHandles: handles };
}

/**
 * Facts the catalog card shows exactly: every achievement of an adult who chose exact achievements, and the result of
 * the partner pool's competition; the rest are generalized. Receipts are issued at the level the card shows a fact.
 */
export function catalogExactFacts(
	source: Pick<CandidateCardSource, 'isMinor' | 'fspAchievements'>,
	extras: readonly ShowExtra[],
	context: Pick<ProjectionContext, 'partnerCompetitionRef'>
): Set<string> {
	const exactAchievements = !source.isMinor && extras.includes('fsp_achievements_exact');
	const poolCompetition = extras.includes('partner_competition_result') ? context.partnerCompetitionRef : undefined;
	return new Set(
		source.fspAchievements
			.filter((achievement) => exactAchievements || achievement.exact.competitionRef === poolCompetition)
			.map((achievement) => achievement.factId)
	);
}

function selfCard(source: CandidateCardSource): CandidateCard {
	const { candidateId, fullName, email, phone, birthDate, isMinor, city, preferences, categories, categoryMissing } =
		source;
	const shown = shownReceipts(source.receipts);
	return {
		projection: 'self',
		candidateId,
		fullName,
		email,
		phone,
		birthDate,
		isMinor,
		city,
		preferences,
		categories,
		categoryMissing,
		desiredRoleKeys: source.desiredRoleKeys,
		fspLevels: source.fspLevels,
		skills: source.skills,
		fspAchievements: source.fspAchievements.map((a) => exactAchievement(a, shown.handlesOf(a))),
		receipts: shown.receipts,
		experience: source.experience,
		experienceSummary: source.experienceSummary,
		education: source.education,
		assessments: source.assessments,
		externalProfiles: source.externalProfiles,
		resumeFileId: source.resumeFileId,
		disclosures: source.disclosures
	};
}

function catalogCard(
	source: CandidateCardSource,
	extras: readonly ShowExtra[],
	context: ProjectionContext
): CandidateCard {
	const exactFacts = catalogExactFacts(source, extras, context);
	// Receipts only at the level each fact is shown: an achievement carries its exact receipts when shown exactly and
	// its generalized ones otherwise, never both — the generalized receipts of a fact issued before it was disclosed
	// exactly stay out of the card, as the exact ones do after the disclosure is withdrawn.
	const shown = shownReceipts(
		source.receipts.filter((receipt) => (receipt.level === 'exact') === exactFacts.has(receipt.factId))
	);
	return {
		projection: 'catalog',
		pseudonym: required(context.pseudonym, 'pseudonym', 'catalog'),
		isMinor: source.isMinor,
		region: source.region,
		regionName: source.regionName,
		preferences: source.preferences,
		categories: source.categories,
		desiredRoleKeys: source.desiredRoleKeys,
		fspLevels: source.fspLevels,
		skills: source.skills,
		fspAchievements: source.fspAchievements.map((achievement) =>
			exactFacts.has(achievement.factId)
				? exactAchievement(achievement, shown.handlesOf(achievement))
				: catalogAchievement(achievement, source.isMinor, shown.handlesOf(achievement))
		),
		receipts: shown.receipts,
		experience: source.experience.map(({ roleKey, duration, appliedSkillKeys }) => ({
			roleKey,
			duration,
			appliedSkillKeys
		})),
		experienceSummary: source.experienceSummary,
		education: source.education.map(({ level, field }) => ({ level, field })),
		assessments: source.assessments.map(({ title, version, scoredOn, level, skillKeys, coverage }) => ({
			title,
			version,
			scoredOn,
			level,
			skillKeys,
			coverage
		})),
		externalProfiles:
			!source.isMinor && extras.includes('external_profiles')
				? source.externalProfiles.filter((profile) => profile.verified)
				: []
	};
}

function recipientCard(source: CandidateCardSource, context: ProjectionContext): CandidateCard {
	const fields = new Set(required(context.disclosedFields, 'disclosedFields', 'recipient'));
	const shown = shownReceipts(source.receipts.filter((receipt) => receipt.level === 'exact'));
	return {
		projection: 'recipient',
		candidateId: source.candidateId,
		pseudonym: required(context.pseudonym, 'pseudonym', 'recipient'),
		...(fields.has('full_name') ? { fullName: source.fullName } : {}),
		...(fields.has('email') ? { email: source.email } : {}),
		...(fields.has('phone') ? { phone: source.phone } : {}),
		...(fields.has('resume') ? { resumeFileId: source.resumeFileId } : {}),
		isMinor: source.isMinor,
		city: source.city,
		preferences: source.preferences,
		categories: source.categories,
		desiredRoleKeys: source.desiredRoleKeys,
		fspLevels: source.fspLevels,
		skills: source.skills,
		fspAchievements: source.fspAchievements.map((a) => exactAchievement(a, shown.handlesOf(a))),
		receipts: shown.receipts,
		experience: source.experience,
		experienceSummary: source.experienceSummary,
		education: source.education,
		assessments: source.assessments.map(({ title, version, scoredOn, level, skillKeys, coverage }) => ({
			title,
			version,
			scoredOn,
			level,
			skillKeys,
			coverage
		})),
		externalProfiles: source.externalProfiles
	};
}

function publicCard(source: CandidateCardSource, context: ProjectionContext): CandidateCard {
	const fields = new Set(required(context.publicFields, 'publicFields', 'public'));
	return {
		projection: 'public',
		...(fields.has('full_name') ? { fullName: source.fullName } : {}),
		...(fields.has('email') ? { email: source.email } : {}),
		...(fields.has('phone') ? { phone: source.phone } : {}),
		...(fields.has('city') ? { city: source.city } : {}),
		...(fields.has('categories') ? { categories: source.categories } : {}),
		...(fields.has('desired_roles') ? { desiredRoleKeys: source.desiredRoleKeys } : {}),
		...(fields.has('fsp_levels') ? { fspLevels: source.fspLevels } : {}),
		...(fields.has('skills') ? { skills: source.skills } : {}),
		...(fields.has('fsp_achievements')
			? { fspAchievements: source.fspAchievements.map((a) => catalogAchievement(a, false, [])) }
			: {}),
		...(fields.has('external_profiles')
			? { externalProfiles: source.externalProfiles.filter((profile) => profile.verified) }
			: {})
	};
}

function operatorCard(source: CandidateCardSource, context: ProjectionContext): CandidateCard {
	const needs = context.operatorNeeds ?? new Set();
	const shown = shownReceipts(source.receipts);
	return {
		projection: 'operator',
		candidateId: source.candidateId,
		fullName: source.fullName,
		...(needs.has('contacts') ? { email: source.email, phone: source.phone } : {}),
		...(needs.has('birth_date') ? { birthDate: source.birthDate } : {}),
		...(needs.has('resume') ? { resumeFileId: source.resumeFileId } : {}),
		isMinor: source.isMinor,
		city: source.city,
		region: source.region,
		regionName: source.regionName,
		preferences: source.preferences,
		categories: source.categories,
		categoryMissing: source.categoryMissing,
		desiredRoleKeys: source.desiredRoleKeys,
		fspLevels: source.fspLevels,
		skills: source.skills,
		fspAchievements: source.fspAchievements.map((a) => exactAchievement(a, shown.handlesOf(a))),
		receipts: shown.receipts,
		experience: source.experience,
		experienceSummary: source.experienceSummary,
		education: source.education,
		assessments: source.assessments,
		externalProfiles: source.externalProfiles,
		disclosures: source.disclosures
	};
}

/** Builds the card of the projection chosen by `canShow`, with the extras of that decision. */
export function projectCandidate(
	source: CandidateCardSource,
	decision: { projection: Projection; extras: readonly ShowExtra[] },
	context: ProjectionContext = {}
): CandidateCard {
	switch (decision.projection) {
		case 'self':
			return selfCard(source);
		case 'catalog':
			return catalogCard(source, decision.extras, context);
		case 'recipient':
			return recipientCard(source, context);
		case 'public':
			return publicCard(source, context);
		case 'operator':
			return operatorCard(source, context);
	}
}
