// States the demo scenario starts from, reached through the product's own actions: invitations with versions of terms,
// answers with disclosed contacts, hiring processes on every stage and with outcomes that differ, an open dispute of a
// category, representatives of minors who sign by the links of their letters, a revoked catalog consent and the pool of
// a competition partner: the heroes of the cast who are its finalists consent to it, so that the clones of a demo
// session show the pool of the session's partner (domain 19.3).
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { confirmRepresentativeContact, inviteRepresentative } from '$lib/server/auth/onboarding';
import {
	grantCatalogVisibility,
	grantPartnerPoolConsent,
	partnerPoolOverview,
	revokeCatalogVisibility
} from '$lib/server/candidates/consents';
import { consentSides } from '$lib/server/consent/effective';
import { sendConsentLetter, signConsentsByRepresentative } from '$lib/server/consent/representative';
import { openDispute } from '$lib/server/categorization/disputes';
import { listedInCatalog, publishedRun } from '$lib/server/db/conditions';
import {
	candidates,
	categorizationRuns,
	categoryDisputes,
	consentEvents,
	hiringProcesses,
	hiringReports,
	invitations,
	invitationTerms,
	matchScores,
	representations,
	vacancies
} from '$lib/server/db/schema';
import { reportHiring, type HiringReportInput } from '$lib/server/hiring/process';
import { markInvitationViewed, respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation, reviseInvitation } from '$lib/server/invitations/send';
import { decideAuthority } from '$lib/server/operator/representatives';
import { documentOf, metaOf, sessionOf, subjectOf, type SeedContext } from './accounts';
import type { SeededCandidate } from './candidates';
import type { SeededCompany } from './companies';
import { Random } from './generate';
import type { SeededVacancy } from './vacancies';

// --- Representatives --------------------------------------------------------------------------------------------------

interface RepresentativeInput {
	fullName: string;
	email: string;
	relation: 'parent' | 'adoptive_parent' | 'guardian' | 'custodian';
}

/**
 * The representative of a minor: invited by the candidate, the address confirmed by the link of the letter; when
 * `verify` — the authority verified by the operator and the processing and catalog consents signed by the link of the
 * letter that follows. Without the verification a representative signs nothing: the link comes only after it.
 */
export async function ensureRepresentative(
	ctx: SeedContext,
	candidate: SeededCandidate,
	input: RepresentativeInput,
	options: { verify: boolean; operatorUserId: string }
): Promise<string> {
	const { db } = ctx.services;
	const current = async () => {
		const [row] = await db
			.select({ id: representations.id, status: representations.status })
			.from(representations)
			.where(and(eq(representations.candidateId, candidate.candidateId), ne(representations.status, 'ended')));
		return row ?? null;
	};
	let representation = await current();
	if (!representation) {
		const invited = await inviteRepresentative(
			ctx.auth,
			metaOf(ctx, candidate.userId),
			sessionOf(ctx, candidate.userId),
			input
		);
		if (!invited.ok) throw new Error(`representative of ${candidate.key} was refused (${invited.reason})`);
		representation = await current();
	}
	if (representation?.status === 'invited') {
		const confirmed = await confirmRepresentativeContact(ctx.auth, ctx.meta, ctx.letters.tokenFor(input.email));
		if (!confirmed.ok) throw new Error(`representative of ${candidate.key} did not confirm the address`);
		representation = await current();
	}
	if (!representation) throw new Error(`representative of ${candidate.key} is missing`);
	if (options.verify && representation.status !== 'authority_verified') {
		await decideAuthority(
			db,
			await subjectOf(ctx, options.operatorUserId),
			metaOf(ctx, options.operatorUserId),
			representation.id,
			{
				result: 'verified',
				method: 'in_person',
				basisKind: 'birth_certificate',
				basisNote: 'Свидетельство о рождении предъявлено на встрече',
				note: ''
			},
			ctx.now()
		);
	}
	if (!options.verify) return representation.id;
	const signed = await consentSides(
		db,
		candidate.candidateId,
		['pd_processing', 'catalog_visibility'],
		representation.id,
		ctx.now()
	);
	if ([...signed.values()].every((side) => side.representative !== null)) return representation.id;
	const letter = await sendConsentLetter(
		ctx.auth,
		ctx.meta,
		{ kind: 'user', userId: options.operatorUserId },
		representation.id
	);
	if (!letter.ok)
		throw new Error(`the consents letter to the representative of ${candidate.key} was not sent (${letter.reason})`);
	const result = await signConsentsByRepresentative(ctx.auth, ctx.meta, ctx.letters.tokenFor(input.email), {
		pd_processing: documentOf(ctx, 'pd_processing').id,
		catalog_visibility: documentOf(ctx, 'catalog_visibility').id
	});
	if (!result.ok) throw new Error(`the representative of ${candidate.key} could not sign (${result.reason})`);
	return representation.id;
}

/** The minor shows the profile in the catalog once the representative is verified (domain 7.3). */
export async function showMinorInCatalog(ctx: SeedContext, candidate: SeededCandidate): Promise<void> {
	const [row] = await ctx.services.db
		.select({ visibility: candidates.visibility })
		.from(candidates)
		.where(eq(candidates.id, candidate.candidateId));
	if (row?.visibility === 'catalog') return;
	await grantCatalogVisibility(ctx.services.db, await subjectOf(ctx, candidate.userId), metaOf(ctx, candidate.userId), {
		documentId: documentOf(ctx, 'catalog_visibility').id,
		scopeFields: []
	});
}

// --- Invitations and hiring ---------------------------------------------------------------------------------------

function sender(company: SeededCompany) {
	const member =
		[...company.members.values()].find((m) => m.role === 'recruiter') ??
		[...company.members.values()].find((m) => m.role === 'owner');
	if (!member) throw new Error(`company ${company.key} has no members`);
	return member;
}

async function invitationOf(ctx: SeedContext, companyId: string, vacancyId: string, candidateId: string) {
	const [row] = await ctx.services.db
		.select({
			id: invitations.id,
			status: invitations.status,
			currentTermsId: invitations.currentTermsId
		})
		.from(invitations)
		.where(
			and(
				eq(invitations.companyId, companyId),
				eq(invitations.vacancyId, vacancyId),
				eq(invitations.candidateId, candidateId)
			)
		);
	return row ?? null;
}

/** The only invitation of the company, vacancy and candidate, sent once. */
async function ensureInvitation(
	ctx: SeedContext,
	company: SeededCompany,
	vacancy: SeededVacancy,
	candidate: SeededCandidate,
	terms: { salaryMin: number; salaryMax: number; message: string | null }
) {
	const existing = await invitationOf(ctx, company.id, vacancy.id, candidate.candidateId);
	if (existing) return existing;
	const member = sender(company);
	await createInvitation(ctx.invitations, await subjectOf(ctx, member.userId), metaOf(ctx, member.userId), {
		vacancyId: vacancy.id,
		candidateId: candidate.candidateId,
		...terms
	});
	const created = await invitationOf(ctx, company.id, vacancy.id, candidate.candidateId);
	if (!created) throw new Error('invitation was not created');
	return created;
}

async function acceptInvitation(
	ctx: SeedContext,
	invitationId: string,
	candidate: SeededCandidate,
	fields: readonly string[]
): Promise<string> {
	const [row] = await ctx.services.db
		.select({ status: invitations.status, termsId: invitations.currentTermsId })
		.from(invitations)
		.where(eq(invitations.id, invitationId));
	if (!row?.termsId) throw new Error(`invitation ${invitationId} has no terms`);
	if (row.status !== 'accepted') {
		await respondToInvitation(
			ctx.invitations,
			await subjectOf(ctx, candidate.userId),
			metaOf(ctx, candidate.userId),
			invitationId,
			{
				termsId: row.termsId,
				decision: 'accept',
				discloseFields: fields,
				disclosureDocumentId: documentOf(ctx, 'contact_disclosure').id
			}
		);
	}
	const [process] = await ctx.services.db
		.select({ id: hiringProcesses.id })
		.from(hiringProcesses)
		.where(eq(hiringProcesses.invitationId, invitationId));
	if (!process) throw new Error(`accepted invitation ${invitationId} opened no hiring process`);
	return process.id;
}

/** A report of one side of a hiring process, unless that side already reported the same. */
async function ensureReport(
	ctx: SeedContext,
	processId: string,
	userId: string,
	input: HiringReportInput
): Promise<void> {
	const [reported] = await ctx.services.db
		.select({ id: hiringReports.id })
		.from(hiringReports)
		.where(
			and(
				eq(hiringReports.processId, processId),
				eq(hiringReports.party, input.party),
				eq(hiringReports.kind, input.kind),
				input.kind === 'stage' && input.stage ? eq(hiringReports.stage, input.stage) : sql`true`
			)
		);
	if (reported) return;
	await reportHiring(ctx.invitations, await subjectOf(ctx, userId), metaOf(ctx, userId), processId, input);
}

// --- Scenario -----------------------------------------------------------------------------------------------------

interface Cast {
	companies: ReadonlyMap<string, SeededCompany>;
	vacancies: readonly SeededVacancy[];
	heroes: ReadonlyMap<string, SeededCandidate>;
	background: readonly SeededCandidate[];
	operatorUserId: string;
	/** What the algorithmist writes in his dispute (`seeds/demo.json`). */
	disputeReason: string;
}

function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`the demo scenario needs ${what}`);
	return value;
}

/**
 * The hero states of the scenario (`seeds/demo.json`): an open invitation to the senior Python developer from the main
 * employer, a revised offer to the Go developer after he accepted the first one, the open dispute of the algorithmist's
 * category, and a process whose sides reported different outcomes.
 */
export async function stageScenario(ctx: SeedContext, cast: Cast): Promise<void> {
	const main = required(cast.companies.get('severny_kod'), 'the main employer');
	const scenarioVacancy = (key: string) =>
		required(
			cast.vacancies.find((v) => v.scenarioKey === key),
			`the vacancy ${key}`
		);

	// An open invitation of the main employer: the candidate revokes the catalog consent on stage.
	const python = scenarioVacancy('python_senior');
	await ensureInvitation(ctx, main, python, required(cast.heroes.get('k5'), 'К-5'), {
		salaryMin: 380_000,
		salaryMax: 450_000,
		message: 'Здравствуйте! Нам близок ваш опыт с логистикой — приглашаем обсудить роль ведущего разработчика.'
	});

	// The first offer accepted, the second one lower: «below the previous offer of this company».
	const go = scenarioVacancy('go_payments');
	const dmitry = required(cast.heroes.get('k2'), 'К-2');
	const offer = await ensureInvitation(ctx, main, go, dmitry, {
		salaryMin: 260_000,
		salaryMax: 290_000,
		message: 'Добрый день! Ищем разработчика в команду платёжного шлюза.'
	});
	await acceptInvitation(ctx, offer.id, dmitry, ['full_name', 'email']);
	const [versions] = await ctx.services.db
		.select({ n: sql<number>`count(*)::int` })
		.from(invitationTerms)
		.where(eq(invitationTerms.invitationId, offer.id));
	if ((versions?.n ?? 0) < 2) {
		const member = sender(main);
		await reviseInvitation(ctx.invitations, await subjectOf(ctx, member.userId), metaOf(ctx, member.userId), offer.id, {
			salaryMin: 235_000,
			salaryMax: 270_000,
			message: 'Бюджет команды пересмотрели: предлагаем обновлённые условия.'
		});
	}

	// The heroes who are finalists of a partner's competition show the card to its partners.
	for (const company of cast.companies.values()) {
		if (company.competitionRef === null) continue;
		for (const hero of cast.heroes.values()) await consentToPool(ctx, company.competitionRef, hero);
	}

	// The algorithmist disputes his category.
	const timur = required(cast.heroes.get('k3'), 'К-3');
	const [run] = await ctx.services.db
		.select({ id: categorizationRuns.id })
		.from(categorizationRuns)
		.where(and(eq(categorizationRuns.candidateId, timur.candidateId), publishedRun(categorizationRuns)))
		.orderBy(desc(categorizationRuns.id))
		.limit(1);
	if (!run) throw new Error('К-3 has no published category to dispute');
	const [dispute] = await ctx.services.db
		.select({ id: categoryDisputes.id })
		.from(categoryDisputes)
		.where(eq(categoryDisputes.candidateId, timur.candidateId));
	if (!dispute) {
		await openDispute(ctx.services.db, {
			candidateId: timur.candidateId,
			userId: timur.userId,
			runId: run.id,
			reason: cast.disputeReason,
			requestId: ctx.meta.requestId
		});
	}
}

// --- Funnel -------------------------------------------------------------------------------------------------------

type Fate =
	| { kind: 'sent' }
	| { kind: 'viewed' }
	| { kind: 'declined'; reason: string }
	| { kind: 'accepted'; stage: 'interview_scheduled' | 'interview_done' | 'offer_made' | 'offer_accepted' | null }
	| { kind: 'outcome'; company: HiringReportInput['outcome']; candidate: HiringReportInput['outcome'] | null };

function fateOf(rnd: Random): Fate {
	return rnd.weighted<Fate>([
		[{ kind: 'sent' }, 16],
		[{ kind: 'viewed' }, 10],
		[{ kind: 'declined', reason: rnd.pick(['salary', 'format', 'stack', 'not_looking']) }, 14],
		[{ kind: 'accepted', stage: null }, 10],
		[{ kind: 'accepted', stage: 'interview_scheduled' }, 12],
		[{ kind: 'accepted', stage: 'interview_done' }, 9],
		[{ kind: 'accepted', stage: 'offer_made' }, 6],
		[{ kind: 'accepted', stage: 'offer_accepted' }, 4],
		[{ kind: 'outcome', company: 'hired', candidate: 'hired' }, 8],
		[{ kind: 'outcome', company: 'hired', candidate: null }, 3],
		[{ kind: 'outcome', company: 'not_hired', candidate: null }, 4],
		[{ kind: 'outcome', company: 'company_stopped', candidate: 'company_stopped' }, 2],
		[{ kind: 'outcome', company: 'candidate_withdrew', candidate: 'candidate_withdrew' }, 2]
	]);
}

const STAGES = ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'] as const;

/**
 * Invitations of the background employers to their best-matching candidates and what became of them: unanswered,
 * viewed, declined with a reason, accepted and at every stage of hiring, with outcomes confirmed by both sides, by one
 * side only, and one process where the sides reported differently. The operator's funnel is built from these.
 */
export async function stageFunnel(ctx: SeedContext, cast: Cast, count: number, batch: string): Promise<number> {
	const { db } = ctx.services;
	const heroIds = new Set([...cast.heroes.values()].map((h) => h.candidateId));
	const byCandidate = new Map(cast.background.map((c) => [c.candidateId, c]));
	const companies = [...cast.companies.values()].filter((c) => c.status === 'verified' && c.key !== 'severny_kod');
	const own = cast.vacancies.filter((v) => v.scenarioKey === null && companies.some((c) => c.key === v.companyKey));
	// A repeated seed finds the funnel it made: the invitations of the background employers are there already. Their
	// number is not compared with `count`: the first seed may find fewer candidates to invite, and a repeated one, after
	// the fates of the funnel and the revoked consents changed the catalog, would pick others and add to the funnel.
	const [made] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(invitations)
		.where(
			inArray(
				invitations.companyId,
				companies.map((c) => c.id)
			)
		);
	if ((made?.n ?? 0) > 0) return made?.n ?? 0;
	const rnd = new Random(`${batch}:funnel`);
	const perCompany = new Map<string, number>();
	const invited = new Set<string>();
	let sent = 0;
	for (const vacancy of rnd.shuffle([...own])) {
		if (sent >= count) break;
		const company = required(cast.companies.get(vacancy.companyKey), `company ${vacancy.companyKey}`);
		// The daily limit of the invitation policy is 50 per company.
		if ((perCompany.get(company.key) ?? 0) >= 40) continue;
		const best = await db
			.select({ candidateId: matchScores.candidateId, score: matchScores.score })
			.from(matchScores)
			.innerJoin(candidates, eq(candidates.id, matchScores.candidateId))
			.where(and(eq(matchScores.vacancyId, vacancy.id), listedInCatalog(candidates), sql`${matchScores.score} > 0`))
			// Ties by the candidate: the same stand after a reset picks the same candidates.
			.orderBy(desc(matchScores.score), asc(matchScores.candidateId))
			.limit(6);
		const picks = best
			.filter(
				(row) => !heroIds.has(row.candidateId) && !invited.has(row.candidateId) && byCandidate.has(row.candidateId)
			)
			.slice(0, 2);
		for (const pick of picks) {
			if (sent >= count) break;
			const candidate = required(byCandidate.get(pick.candidateId), 'a background candidate');
			const [vacancyRow] = await db
				.select({ min: vacancies.salaryMin, max: vacancies.salaryMax })
				.from(vacancies)
				.where(eq(vacancies.id, vacancy.id));
			if (vacancyRow?.min == null || vacancyRow.max == null) {
				throw new Error(`own vacancy ${vacancy.id} has no full salary range`);
			}
			const invitation = await ensureInvitation(ctx, company, vacancy, candidate, {
				salaryMin: vacancyRow.min,
				salaryMax: vacancyRow.max,
				message: null
			});
			invited.add(candidate.candidateId);
			perCompany.set(company.key, (perCompany.get(company.key) ?? 0) + 1);
			sent++;
			await playFate(ctx, fateOf(rnd), invitation.id, company, candidate, sent === 1);
		}
	}
	return sent;
}

async function playFate(
	ctx: SeedContext,
	fate: Fate,
	invitationId: string,
	company: SeededCompany,
	candidate: SeededCandidate,
	diverged: boolean
): Promise<void> {
	const member = sender(company);
	const [row] = await ctx.services.db
		.select({ status: invitations.status, termsId: invitations.currentTermsId })
		.from(invitations)
		.where(eq(invitations.id, invitationId));
	if (!row) throw new Error(`invitation ${invitationId} disappeared`);
	// The first process of the funnel is the one whose sides disagree: «the other side reported otherwise».
	const effective: Fate = diverged ? { kind: 'outcome', company: 'hired', candidate: 'not_hired' } : fate;
	if (effective.kind === 'sent') return;
	if (effective.kind === 'viewed') {
		if (row.status === 'sent') {
			await markInvitationViewed(ctx.invitations, await subjectOf(ctx, candidate.userId), invitationId);
		}
		return;
	}
	if (effective.kind === 'declined') {
		if (row.status === 'sent' || row.status === 'viewed') {
			if (!row.termsId) throw new Error(`invitation ${invitationId} has no terms`);
			await respondToInvitation(
				ctx.invitations,
				await subjectOf(ctx, candidate.userId),
				metaOf(ctx, candidate.userId),
				invitationId,
				{ termsId: row.termsId, decision: 'decline', reasonCode: effective.reason }
			);
		}
		return;
	}
	const processId = await acceptInvitation(ctx, invitationId, candidate, ['full_name', 'email']);
	const stageUntil = effective.kind === 'accepted' ? effective.stage : 'offer_accepted';
	if (stageUntil !== null) {
		for (const stage of STAGES.slice(0, STAGES.indexOf(stageUntil) + 1)) {
			await ensureReport(ctx, processId, member.userId, { party: 'company', kind: 'stage', stage });
		}
	}
	if (effective.kind !== 'outcome') return;
	const hired = (outcome: HiringReportInput['outcome']) =>
		outcome === 'hired'
			? { startDate: new Date(ctx.now().getTime() + 14 * 86_400_000).toISOString().slice(0, 10) }
			: {};
	await ensureReport(ctx, processId, member.userId, {
		party: 'company',
		kind: 'outcome',
		outcome: effective.company,
		...hired(effective.company)
	});
	if (effective.candidate !== null) {
		await ensureReport(ctx, processId, candidate.userId, {
			party: 'candidate',
			kind: 'outcome',
			outcome: effective.candidate,
			...hired(effective.candidate)
		});
	}
}

// --- Consents -------------------------------------------------------------------------------------------------------

/** Background candidates who stopped showing the profile in the catalog: they leave the search and the counters. */
export async function revokeSomeConsents(
	ctx: SeedContext,
	background: readonly SeededCandidate[],
	share: number,
	batch: string
): Promise<number> {
	const rnd = new Random(`${batch}:revocations`);
	let revoked = 0;
	for (const candidate of background) {
		if (!rnd.chance(share)) continue;
		const [last] = await ctx.services.db
			.select({ action: consentEvents.action })
			.from(consentEvents)
			.where(
				and(
					eq(consentEvents.subjectCandidateId, candidate.candidateId),
					eq(consentEvents.kind, 'catalog_visibility'),
					eq(consentEvents.signerKind, 'subject')
				)
			)
			.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
			.limit(1);
		if (last?.action !== 'grant') continue;
		const [open] = await ctx.services.db
			.select({ id: invitations.id })
			.from(invitations)
			.where(and(eq(invitations.candidateId, candidate.candidateId), inArray(invitations.status, ['sent', 'viewed'])))
			.limit(1);
		if (open) continue;
		await revokeCatalogVisibility(
			ctx.services.db,
			await subjectOf(ctx, candidate.userId),
			metaOf(ctx, candidate.userId),
			'Нашёл работу'
		);
		revoked++;
	}
	return revoked;
}

/**
 * The candidate's consent to the pool of the partners of a competition, given on the candidate's screen when the
 * product offers it: an adult whose result fits the rule of an open partnership. `true` — the consent is in effect.
 */
async function consentToPool(ctx: SeedContext, competitionRef: string, candidate: SeededCandidate): Promise<boolean> {
	const overview = await partnerPoolOverview(ctx.services.db, candidate.candidateId, ctx.now());
	const offer = overview.offers.find((item) => item.competitionRef === competitionRef);
	if (!overview.adult || !offer || offer.partners.length === 0) return false;
	if (offer.consent?.effective && offer.newPartners.length === 0) return true;
	await grantPartnerPoolConsent(
		ctx.services.db,
		await subjectOf(ctx, candidate.userId),
		metaOf(ctx, candidate.userId),
		{ documentId: documentOf(ctx, 'partner_pool').id, competitionRef }
	);
	return true;
}

/**
 * The consent of finalists of a partner's competition to its pool (domain 5.5): most of the candidates with a result
 * of the competition that the pool rule admits.
 */
export async function grantPartnerPool(
	ctx: SeedContext,
	competitionRef: string,
	finalists: readonly SeededCandidate[],
	batch: string
): Promise<number> {
	const rnd = new Random(`${batch}:partner-pool`);
	let granted = 0;
	for (const candidate of finalists) {
		if (!rnd.chance(0.8)) continue;
		if (await consentToPool(ctx, competitionRef, candidate)) granted++;
	}
	return granted;
}
