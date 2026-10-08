// States the demo scenario starts from, reached through the product's own actions (docs/domain.md, 13.5, 13.10, 19.3):
// needs of the companies with their shortlists and marks, offers from the shortlists with every status an offer reaches,
// accepted ones with the contacts disclosed and the hiring on every stage, representatives of minors who sign by the
// links of their letters, a revoked catalog consent and the pool of a competition partner: the heroes of the cast who
// are its finalists consent to it, so that the clones of a demo session show the pool of the session's partner.
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { gradeDefinition, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { activeCategories } from '$lib/server/categories/read';
import { confirmRepresentativeContact, inviteRepresentative } from '$lib/server/auth/onboarding';
import {
	grantCatalogVisibility,
	grantPartnerPoolConsent,
	partnerPoolOverview,
	revokeCatalogVisibility
} from '$lib/server/candidates/consents';
import { consentSides } from '$lib/server/consent/effective';
import { sendConsentLetter, signConsentsByRepresentative } from '$lib/server/consent/representative';
import {
	applications,
	candidates,
	challengeDeliveries,
	challengeSolutions,
	companyChallenges,
	confirmationRequests,
	consentEvents,
	hiringNeeds,
	hiringProcesses,
	hiringReports,
	invitationMessages,
	invitations,
	invitationTerms,
	representations,
	shortlists
} from '$lib/server/db/schema';
import { applyToVacancy } from '$lib/server/applications/service';
import { openDelivery, submitSolution } from '$lib/server/challenges/candidate';
import { createChallenge, dismissSolution } from '$lib/server/challenges/company';
import { deliverChallenges } from '$lib/server/challenges/deliver';
import { requestableBlocks, requestConfirmation } from '$lib/server/confirmations/requests';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { reportHiring, type HiringReportInput } from '$lib/server/hiring/process';
import { whyYouFromShortlist } from '$lib/server/invitations/offer-form';
import { markInvitationViewed, respondToInvitation } from '$lib/server/invitations/respond';
import {
	createInvitation,
	reviseInvitation,
	withdrawInvitation,
	type CreateInvitationInput
} from '$lib/server/invitations/send';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { sendMessage } from '$lib/server/messages/conversation';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { fail } from '$lib/server/ml/result';
import type { NeedForm } from '$lib/server/needs/form';
import { createNeed, getNeed, updateNeed } from '$lib/server/needs/service';
import { redisTextParseCache } from '$lib/server/vacancies/text-extract';
import { decideAuthority } from '$lib/server/operator/representatives';
import {
	createShortlist,
	markCandidate,
	openShortlist,
	shortlistMatchOf,
	type ShortlistDeps
} from '$lib/server/shortlists/service';
import { documentOf, metaOf, sessionOf, subjectOf, type SeedContext } from './accounts';
import type { SeededCandidate } from './candidates';
import type { SeededCompany } from './companies';
import type { ScenarioOffer, SeedData } from './data';
import type { SeedModels } from './model-parses';
import { Random, type NeedPlan } from './generate';

/** Shortlists of the seed rank without the models: the stand does not wait for them. */
const MODELS_OFF: MatchingModels = {
	embed: () => Promise.resolve(fail('disabled', 'embed: off for the demo seed', { reason: 'demo_seed' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: off for the demo seed', { reason: 'demo_seed' }))
};

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

// --- Needs, shortlists, offers and hiring ---------------------------------------------------------------------------

function sender(company: SeededCompany) {
	const member =
		[...company.members.values()].find((m) => m.role === 'recruiter') ??
		[...company.members.values()].find((m) => m.role === 'owner');
	if (!member) throw new Error(`company ${company.key} has no members`);
	return member;
}

/** Matching as the shortlists of the stand rank: without the models, so the seed does not wait for them. */
function shortlistDeps(ctx: SeedContext): ShortlistDeps {
	const { db, crypto } = ctx.services;
	return {
		db,
		models: MODELS_OFF,
		pseudonym: (candidateId, companyId) => crypto.pseudonym(candidateId, companyId),
		now: ctx.now,
		testResults: GRADE_DECISION_RESULTS
	};
}

/** Needs of a scenario company get the model's stored answer, like the heroes' resumes (`model-parses.ts`); others are read by rules. */
const RULES_ONLY: Pick<ModelAdapter, 'extract' | 'extractModelKey'> = {
	extract: () =>
		Promise.resolve(
			fail('disabled', 'extract: background needs of the demo seed are read by the rules', {
				reason: 'demo_seed_background'
			})
		),
	extractModelKey: () => null
};

export interface NeedInput {
	text: string | null;
	form: NeedForm;
}

/**
 * The `index`-th need of the company, active: the employer writes the text and the form, the parse fills what the form
 * leaves, the employer confirms. Needs are created in the order of the plans, so a repeated seed finds them by position.
 */
async function ensureNeed(
	ctx: SeedContext,
	company: SeededCompany,
	index: number,
	input: NeedInput,
	models: Pick<ModelAdapter, 'extract' | 'extractModelKey'>
): Promise<string> {
	const { db } = ctx.services;
	const existing = await db
		.select({ id: hiringNeeds.id, status: hiringNeeds.status })
		.from(hiringNeeds)
		.where(eq(hiringNeeds.companyId, company.id))
		.orderBy(asc(hiringNeeds.createdAt), asc(hiringNeeds.id));
	const member = sender(company);
	const subject = await subjectOf(ctx, member.userId);
	const meta = metaOf(ctx, member.userId);
	const deps = { db, models, parseCache: redisTextParseCache(() => Promise.resolve(ctx.services.redis)), now: ctx.now };
	let need = existing[index];
	if (!need) {
		const created = await createNeed(deps, subject, meta, { text: input.text, form: input.form });
		need = { id: created.id, status: created.status };
	}
	if (need.status === 'draft') {
		const view = await getNeed(deps, subject, need.id);
		await updateNeed(deps, subject, meta, need.id, { form: view.form, status: 'active' });
	}
	return need.id;
}

/** The shortlist of a need with the categories the need recommends; one per need. */
async function ensureShortlist(ctx: SeedContext, company: SeededCompany, needId: string): Promise<string> {
	const [existing] = await ctx.services.db
		.select({ id: shortlists.id })
		.from(shortlists)
		.where(eq(shortlists.needId, needId));
	if (existing) return existing.id;
	const member = sender(company);
	const created = await createShortlist(
		shortlistDeps(ctx),
		await subjectOf(ctx, member.userId),
		metaOf(ctx, member.userId),
		needId,
		{}
	);
	return created.id;
}

/** The candidates of the shortlist as the company sees it now, best first. */
/**
 * The candidates of a shortlist with a confirmed grade, best first: the background funnel marks and offers to them. The
 * group «грейд не подтверждён» after them stays in the shortlist for the employer to weigh (domain 13.10).
 */
async function rankedOf(ctx: SeedContext, company: SeededCompany, shortlistId: string): Promise<string[]> {
	const view = await openShortlist(shortlistDeps(ctx), await subjectOf(ctx, sender(company).userId), shortlistId, {
		limit: 50
	});
	return view.items.filter((item) => item.needMatch.group === 'confirmed').map((item) => item.candidateId);
}

async function mark(
	ctx: SeedContext,
	company: SeededCompany,
	shortlistId: string,
	candidateId: string,
	note: string | null
): Promise<void> {
	const member = sender(company);
	await markCandidate(
		shortlistDeps(ctx),
		await subjectOf(ctx, member.userId),
		metaOf(ctx, member.userId),
		shortlistId,
		ctx.services.crypto.pseudonym(candidateId, company.id),
		note
	);
}

async function invitationOf(ctx: SeedContext, companyId: string, candidateId: string) {
	const [row] = await ctx.services.db
		.select({ id: invitations.id, status: invitations.status, currentTermsId: invitations.currentTermsId })
		.from(invitations)
		.where(and(eq(invitations.companyId, companyId), eq(invitations.candidateId, candidateId)));
	return row ?? null;
}

export interface OfferTerms {
	title: string;
	description: string;
	salaryMin: number;
	salaryMax: number;
	taxBase: 'net' | 'gross';
	workFormat: string;
	contact: { kind: string; value: string };
	message: string | null;
}

/**
 * The offer from a shortlist, as the card opened from it writes it (domain 13.5, 13.10): the reasons of the shortlist
 * become the points of «why you», the offer names the need.
 */
/**
 * The points of «why you» the shortlist gives the candidate, as the employer takes them into an offer, and the need of
 * the shortlist. The shortlist may name the strongest block of the test, which need not be a defining one, while an
 * offer accepts only the defining blocks and the practice of the category (domain 13.5): the employer leaves such a
 * point out.
 */
async function shortlistPoints(ctx: SeedContext, company: SeededCompany, shortlistId: string, candidateId: string) {
	const subject = await subjectOf(ctx, sender(company).userId);
	const found = await shortlistMatchOf(shortlistDeps(ctx), subject, shortlistId, candidateId);
	if (!found) throw new Error(`candidate ${candidateId} is not in shortlist ${shortlistId} of ${company.key}`);
	const labels = labelsOf(await currentVocabulary(ctx.services.db));
	const categories = (await activeCategories(ctx.services.db, [candidateId])).get(candidateId) ?? [];
	const passed = new Set(
		categories.flatMap((category) => [
			...category.confirmedBlocks,
			gradeDefinition(category.specialization, category.grade).practice.block
		])
	);
	const points = whyYouFromShortlist(found.match, [], {
		skills: labels.skills,
		workFormats: labels.terms.work_format,
		specializations: labels.specializations,
		grades: labels.grades
	})
		.filter((point) => point.source.kind !== 'test_block' || passed.has(point.source.ref))
		.slice(0, 5);
	return { points, needId: found.needId };
}

async function offerInput(
	ctx: SeedContext,
	company: SeededCompany,
	shortlistId: string,
	candidateId: string,
	terms: OfferTerms
): Promise<CreateInvitationInput> {
	const { points, needId } = await shortlistPoints(ctx, company, shortlistId, candidateId);
	if (points.length === 0) throw new Error(`the shortlist gives no point of «why you» for ${candidateId}`);
	return {
		title: terms.title,
		description: terms.description,
		salaryMin: terms.salaryMin,
		salaryMax: terms.salaryMax,
		salaryCurrency: 'RUB',
		salaryTaxBase: terms.taxBase,
		workFormat: terms.workFormat,
		contactMethod: terms.contact,
		whyYou: points.map((point) => ({ text: point.text, source: point.source })),
		message: terms.message,
		candidateId,
		needId
	};
}

/** The only line of offers of the company to the candidate, sent once from the shortlist. */
async function ensureOffer(
	ctx: SeedContext,
	company: SeededCompany,
	shortlistId: string,
	candidateId: string,
	terms: OfferTerms
) {
	const existing = await invitationOf(ctx, company.id, candidateId);
	if (existing) return existing;
	const member = sender(company);
	await createInvitation(
		ctx.invitations,
		await subjectOf(ctx, member.userId),
		metaOf(ctx, member.userId),
		await offerInput(ctx, company, shortlistId, candidateId, terms)
	);
	const created = await invitationOf(ctx, company.id, candidateId);
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

type ScenarioMessage = NonNullable<ScenarioOffer['messages']>[number];

/**
 * The conversation of an accepted offer, written once through the product: the company's side as its sender, the
 * candidate as the hero. An offer that already has messages is left as it is.
 */
async function ensureConversation(
	ctx: SeedContext,
	invitationId: string,
	memberUserId: string,
	candidate: SeededCandidate,
	messages: readonly ScenarioMessage[]
): Promise<void> {
	const [written] = await ctx.services.db
		.select({ id: invitationMessages.id })
		.from(invitationMessages)
		.where(eq(invitationMessages.invitationId, invitationId))
		.limit(1);
	if (written) return;
	for (const message of messages) {
		const userId = message.from === 'company' ? memberUserId : candidate.userId;
		await sendMessage(ctx.invitations, await subjectOf(ctx, userId), metaOf(ctx, userId), invitationId, message.text);
	}
}

const STAGES = ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'] as const;
type Stage = (typeof STAGES)[number];

/** What became of an offer: every status an offer reaches without the time passing (domain 13.5). */
type Fate =
	| { kind: 'sent' }
	| { kind: 'viewed' }
	| { kind: 'declined'; reason: string }
	| { kind: 'withdrawn' }
	| { kind: 'revised_lower' }
	| {
			kind: 'accepted';
			stages: readonly Stage[];
			disclose: readonly string[];
			/** The conversation after the acceptance; none — the offer has no messages. */
			messages?: readonly ScenarioMessage[];
	  }
	| { kind: 'outcome'; company: HiringReportInput['outcome']; candidate: HiringReportInput['outcome'] | null };

async function playFate(
	ctx: SeedContext,
	fate: Fate,
	invitationId: string,
	company: SeededCompany,
	candidate: SeededCandidate,
	revised: () => Promise<CreateInvitationInput>
): Promise<void> {
	const member = sender(company);
	const [row] = await ctx.services.db
		.select({ status: invitations.status, termsId: invitations.currentTermsId })
		.from(invitations)
		.where(eq(invitations.id, invitationId));
	if (!row) throw new Error(`invitation ${invitationId} disappeared`);
	const open = row.status === 'sent' || row.status === 'viewed';
	switch (fate.kind) {
		case 'sent':
			return;
		case 'viewed':
			if (row.status === 'sent') {
				await markInvitationViewed(ctx.invitations, await subjectOf(ctx, candidate.userId), invitationId);
			}
			return;
		case 'declined':
			if (!open) return;
			if (!row.termsId) throw new Error(`invitation ${invitationId} has no terms`);
			await respondToInvitation(
				ctx.invitations,
				await subjectOf(ctx, candidate.userId),
				metaOf(ctx, candidate.userId),
				invitationId,
				{ termsId: row.termsId, decision: 'decline', reasonCode: fate.reason }
			);
			return;
		case 'withdrawn':
			if (!open) return;
			await withdrawInvitation(
				ctx.invitations,
				await subjectOf(ctx, member.userId),
				metaOf(ctx, member.userId),
				invitationId
			);
			return;
		case 'revised_lower': {
			const [versions] = await ctx.services.db
				.select({ n: sql<number>`count(*)::int` })
				.from(invitationTerms)
				.where(eq(invitationTerms.invitationId, invitationId));
			if ((versions?.n ?? 0) >= 2) return;
			const input = await revised();
			await reviseInvitation(
				ctx.invitations,
				await subjectOf(ctx, member.userId),
				metaOf(ctx, member.userId),
				invitationId,
				{ ...input, message: 'Бюджет команды пересмотрели: предлагаем обновлённые условия.' }
			);
			return;
		}
		case 'accepted':
		case 'outcome': {
			const disclose = fate.kind === 'accepted' ? fate.disclose : ['full_name', 'email'];
			const processId = await acceptInvitation(ctx, invitationId, candidate, disclose);
			const stages = fate.kind === 'accepted' ? fate.stages : STAGES;
			for (const stage of stages) {
				await ensureReport(ctx, processId, member.userId, { party: 'company', kind: 'stage', stage });
			}
			if (fate.kind === 'accepted' && fate.messages !== undefined) {
				await ensureConversation(ctx, invitationId, member.userId, candidate, fate.messages);
			}
			if (fate.kind !== 'outcome') return;
			const hired = (outcome: HiringReportInput['outcome']) =>
				outcome === 'hired'
					? { startDate: new Date(ctx.now().getTime() + 14 * 86_400_000).toISOString().slice(0, 10) }
					: {};
			await ensureReport(ctx, processId, member.userId, {
				party: 'company',
				kind: 'outcome',
				outcome: fate.company,
				...hired(fate.company)
			});
			if (fate.candidate !== null) {
				await ensureReport(ctx, processId, candidate.userId, {
					party: 'candidate',
					kind: 'outcome',
					outcome: fate.candidate,
					...hired(fate.candidate)
				});
			}
		}
	}
}

// --- Scenario -----------------------------------------------------------------------------------------------------

export interface Cast {
	companies: ReadonlyMap<string, SeededCompany>;
	heroes: ReadonlyMap<string, SeededCandidate>;
	background: readonly SeededCandidate[];
	operatorUserId: string;
}

function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`the demo scenario needs ${what}`);
	return value;
}

/**
 * The states of the scenario companies (`seeds/demo.json`): each need written as «Опишите, кого ищете» and confirmed,
 * its shortlist with the heroes the company marked, and the offers to heroes taken as far as the scenario shows them —
 * sent, viewed, accepted with the contacts disclosed and the stages of hiring.
 */
export async function stageScenario(
	ctx: SeedContext,
	cast: Cast,
	data: SeedData,
	open: ReadonlySet<SpecializationKey>,
	models: SeedModels
): Promise<string[]> {
	const closed: string[] = [];
	for (const plan of data.demo.companies) {
		const company = required(cast.companies.get(plan.key), `company ${plan.key}`);
		const shortlistOf = new Map<string, string>();
		for (const [index, need] of (plan.needs ?? []).entries()) {
			// A need of a specialization without a released test has no categories to shortlist: the scene waits for it.
			if (need.form.specialization !== undefined && !open.has(need.form.specialization)) {
				closed.push(`${plan.key}.${need.key}`);
				continue;
			}
			const needId = await ensureNeed(
				ctx,
				company,
				index,
				{ text: need.text, form: need.form },
				models.need(need.text)
			);
			const shortlistId = await ensureShortlist(ctx, company, needId);
			shortlistOf.set(need.key, shortlistId);
			for (const marked of need.marks) {
				const hero = required(cast.heroes.get(marked.candidate), `hero ${marked.candidate}`);
				await mark(ctx, company, shortlistId, hero.candidateId, marked.note);
			}
		}
		for (const offer of plan.offers ?? []) {
			if (offer.need !== undefined && closed.includes(`${plan.key}.${offer.need}`)) continue;
			const hero = required(cast.heroes.get(offer.candidate), `hero ${offer.candidate}`);
			const shortlistId = required(
				offer.need === undefined ? undefined : shortlistOf.get(offer.need),
				`the shortlist of the offer to ${offer.candidate}`
			);
			const terms: OfferTerms = {
				title: offer.title,
				description: offer.description,
				salaryMin: offer.salary.min,
				salaryMax: offer.salary.max,
				taxBase: offer.salary.taxBase,
				workFormat: offer.workFormat,
				contact: offer.contact,
				message: offer.message
			};
			const invitation = await ensureOffer(ctx, company, shortlistId, hero.candidateId, terms);
			const fate: Fate =
				offer.state === 'accepted'
					? {
							kind: 'accepted',
							stages: offer.stages ?? [],
							disclose: offer.disclose ?? ['full_name', 'email'],
							...(offer.messages === undefined ? {} : { messages: offer.messages })
						}
					: offer.state === 'declined'
						? { kind: 'declined', reason: 'other' }
						: { kind: offer.state };
			await playFate(ctx, fate, invitation.id, company, hero, () =>
				offerInput(ctx, company, shortlistId, hero.candidateId, terms)
			);
		}
	}
	// The heroes who are finalists of a partner's competition show the card to its partners.
	for (const company of cast.companies.values()) {
		if (company.competitionRef === null) continue;
		for (const hero of cast.heroes.values()) await consentToPool(ctx, company.competitionRef, hero);
	}
	return closed;
}

// --- Funnel -------------------------------------------------------------------------------------------------------

function fateOf(rnd: Random): Fate {
	return rnd.weighted<Fate>([
		[{ kind: 'sent' }, 14],
		[{ kind: 'viewed' }, 10],
		[{ kind: 'declined', reason: rnd.pick(['salary', 'format', 'stack', 'not_looking']) }, 13],
		[{ kind: 'withdrawn' }, 4],
		[{ kind: 'revised_lower' }, 5],
		[{ kind: 'accepted', stages: [], disclose: ['full_name', 'email'] }, 9],
		[{ kind: 'accepted', stages: STAGES.slice(0, 1), disclose: ['full_name', 'email'] }, 10],
		[{ kind: 'accepted', stages: STAGES.slice(0, 2), disclose: ['full_name', 'email', 'resume'] }, 8],
		[{ kind: 'accepted', stages: STAGES.slice(0, 3), disclose: ['full_name', 'email'] }, 5],
		[{ kind: 'outcome', company: 'hired', candidate: 'hired' }, 8],
		[{ kind: 'outcome', company: 'hired', candidate: null }, 3],
		[{ kind: 'outcome', company: 'not_hired', candidate: null }, 4],
		[{ kind: 'outcome', company: 'company_stopped', candidate: 'company_stopped' }, 2],
		[{ kind: 'outcome', company: 'candidate_withdrew', candidate: 'candidate_withdrew' }, 2]
	]);
}

export interface FunnelSummary {
	needs: number;
	/** Needs of the plans whose specialization has no released test: the seed does not write them. */
	closedNeeds: number;
	offers: number;
}

/**
 * Needs of the background companies, their shortlists and the offers to the best of each, with every status an offer
 * reaches: unanswered, viewed, declined with a reason, withdrawn, revised lower, accepted with the contacts disclosed and
 * at every stage of hiring, with outcomes confirmed by both sides, by one side only, and one process where the sides
 * reported differently. The operator's funnel is built from these.
 */
export async function stageFunnel(
	ctx: SeedContext,
	cast: Cast,
	plans: readonly NeedPlan[],
	open: ReadonlySet<SpecializationKey>,
	count: number,
	batch: string
): Promise<FunnelSummary> {
	const heroIds = new Set([...cast.heroes.values()].map((h) => h.candidateId));
	const byCandidate = new Map(cast.background.map((c) => [c.candidateId, c]));
	const rnd = new Random(`${batch}:funnel`);
	const index = new Map<string, number>();
	const perCompany = new Map<string, number>();
	const offered = new Map<string, Set<string>>();
	const summary: FunnelSummary = { needs: 0, closedNeeds: 0, offers: 0 };
	let diverged = false;
	for (const plan of plans) {
		const specialization = plan.form.specialization;
		if (specialization !== undefined && !open.has(specialization)) {
			summary.closedNeeds++;
			continue;
		}
		const company = required(cast.companies.get(plan.company), `company ${plan.company}`);
		const position = index.get(company.key) ?? 0;
		index.set(company.key, position + 1);
		const needId = await ensureNeed(ctx, company, position, plan, RULES_ONLY);
		summary.needs++;
		const shortlistId = await ensureShortlist(ctx, company, needId);
		const ranked = (await rankedOf(ctx, company, shortlistId)).filter((id) => !heroIds.has(id) && byCandidate.has(id));
		for (const candidateId of ranked.slice(0, 2)) await mark(ctx, company, shortlistId, candidateId, null);
		// One line of offers per company and candidate: a candidate the company's other need already reached is skipped.
		const reached = offered.get(company.key) ?? new Set<string>();
		offered.set(company.key, reached);
		// An offer names why the candidate: one the shortlist explains nothing about is not offered to.
		let sent = 0;
		for (const candidateId of ranked.filter((id) => !reached.has(id))) {
			if (sent >= plan.offers || summary.offers >= count) break;
			const offeredBefore = await invitationOf(ctx, company.id, candidateId);
			if (!offeredBefore && (await shortlistPoints(ctx, company, shortlistId, candidateId)).points.length === 0)
				continue;
			sent++;
			reached.add(candidateId);
			// The daily limit of the invitation policy is 50 per company.
			if ((perCompany.get(company.key) ?? 0) >= 40) break;
			const candidate = required(byCandidate.get(candidateId), 'a background candidate');
			const terms = plan.terms;
			const invitation = await ensureOffer(ctx, company, shortlistId, candidateId, terms);
			perCompany.set(company.key, (perCompany.get(company.key) ?? 0) + 1);
			summary.offers++;
			// The first accepted process of the funnel is the one whose sides disagree: «the other side reported otherwise».
			let fate = fateOf(rnd);
			if (!diverged) {
				fate = { kind: 'outcome', company: 'hired', candidate: 'not_hired' };
				diverged = true;
			}
			await playFate(ctx, fate, invitation.id, company, candidate, async () => {
				const input = await offerInput(ctx, company, shortlistId, candidateId, terms);
				const lower = Math.max(5_000, Math.round((terms.salaryMin * 0.9) / 5_000) * 5_000);
				return { ...input, salaryMin: lower, salaryMax: Math.max(lower, terms.salaryMax - 20_000) };
			});
		}
	}
	return summary;
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
 * of the competition that the pool rule admits — four of five, rounded up, so that a small world still has a pool.
 */
export async function grantPartnerPool(
	ctx: SeedContext,
	competitionRef: string,
	finalists: readonly SeededCandidate[],
	batch: string
): Promise<number> {
	const rnd = new Random(`${batch}:partner-pool`);
	let granted = 0;
	for (const candidate of rnd.shuffle([...finalists]).slice(0, Math.ceil(finalists.length * 0.8))) {
		if (await consentToPool(ctx, competitionRef, candidate)) granted++;
	}
	return granted;
}

// --- Calls, applications and requests of a confirmation --------------------------------------------------------------

/**
 * The other ways of contact of the scenario (domain 13.6, 13.11, 13.12): the main employer publishes a call for the
 * backend categories; the hourly delivery offers it, a few background candidates send solutions and the company sets
 * one of them aside, while К-1 leaves it unanswered — he sends his approach on stage; К-2 applies to the main employer's
 * vacancy of the payment gateway, so its applications are not empty before the stage; the main employer asks К-1 to
 * confirm a block the category does not cover. К-1 neither applies nor answers: until he accepts the offer of the
 * stage, the main employer holds none of his contacts. A repeated seed finds each of them done.
 */
export async function stageContacts(
	ctx: SeedContext,
	cast: Cast,
	vacancyId: string,
	open: ReadonlySet<SpecializationKey>
): Promise<boolean> {
	if (!open.has('backend')) return false;
	const { db, crypto } = ctx.services;
	const stepan = required(cast.heroes.get('k1'), 'hero k1');
	const dmitry = required(cast.heroes.get('k2'), 'hero k2');
	const main = required(cast.companies.get('severny_kod'), 'company severny_kod');
	const deps = { db, crypto, now: ctx.now };

	// The call and its solutions.
	const author = sender(main);
	const authorSubject = await subjectOf(ctx, author.userId);
	let [call] = await db
		.select({ id: companyChallenges.id })
		.from(companyChallenges)
		.where(eq(companyChallenges.companyId, main.id));
	if (!call) {
		call = await createChallenge(deps, authorSubject, metaOf(ctx, author.userId), {
			title: 'Идемпотентный приём платежей',
			statement:
				'Сервис принимает платёж от партнёра и иногда получает один и тот же запрос дважды. Опишите, как сделать приём идемпотентным: ключ, хранение, ответ на повтор, что делать при сбое между записью и ответом.',
			answerKind: 'approach',
			specialization: 'backend',
			grades: ['middle', 'senior'],
			salaryMin: 250_000,
			salaryMax: 350_000,
			salaryCurrency: 'RUB',
			salaryTaxBase: 'net',
			goal: 'Ищем backend-разработчика в команду платёжной платформы',
			timeLimitMinutes: 20,
			endsAt: new Date(ctx.now().getTime() + 14 * 86_400_000),
			publish: true
		});
		await db.transaction((tx) => deliverChallenges(tx, ctx.now(), 'all', ctx.meta.requestId));
	}
	const deliveries = await db
		.select({ id: challengeDeliveries.id, candidateId: challengeDeliveries.candidateId })
		.from(challengeDeliveries)
		.where(eq(challengeDeliveries.challengeId, call.id))
		.orderBy(asc(challengeDeliveries.id));
	if (!deliveries.some((d) => d.candidateId === stepan.candidateId)) {
		throw new Error('the call of the main employer was not offered to К-1');
	}
	const byCandidate = new Map(cast.background.map((c) => [c.candidateId, c]));
	const solvers = deliveries.filter((d) => byCandidate.has(d.candidateId)).slice(0, 3);
	for (const delivery of solvers) {
		const solver = required(byCandidate.get(delivery.candidateId), 'a solver');
		const [solution] = await db
			.select({ id: challengeSolutions.id })
			.from(challengeSolutions)
			.where(eq(challengeSolutions.deliveryId, delivery.id));
		if (solution) continue;
		const subject = await subjectOf(ctx, solver.userId);
		await openDelivery(deps, subject, delivery.id);
		await submitSolution(
			deps,
			subject,
			metaOf(ctx, solver.userId),
			delivery.id,
			'Храню ключ запроса в таблице с уникальным индексом и на повтор отдаю сохранённый ответ.'
		);
	}
	const [setAside] = await db
		.select({ id: challengeSolutions.id, decision: challengeSolutions.companyDecision })
		.from(challengeSolutions)
		.innerJoin(challengeDeliveries, eq(challengeDeliveries.id, challengeSolutions.deliveryId))
		.where(eq(challengeDeliveries.challengeId, call.id))
		.orderBy(asc(challengeSolutions.id))
		.limit(1);
	if (setAside && setAside.decision === null) {
		await dismissSolution(deps, authorSubject, metaOf(ctx, author.userId), call.id, setAside.id);
	}

	// The application of К-2 to the main employer's vacancy.
	const [applied] = await db
		.select({ id: applications.id })
		.from(applications)
		.where(eq(applications.candidateId, dmitry.candidateId));
	if (!applied) {
		await applyToVacancy(deps, await subjectOf(ctx, dmitry.userId), metaOf(ctx, dmitry.userId), {
			vacancyId,
			message: 'Пишу платёжные сервисы на Go: PostgreSQL и Kafka под нагрузкой — интересен ваш шлюз.',
			discloseFields: ['full_name', 'email'],
			disclosureDocumentId: documentOf(ctx, 'contact_disclosure').id
		});
	}

	// The main employer asks К-1 to confirm a block the category does not cover.
	const [asked] = await db
		.select({ id: confirmationRequests.id })
		.from(confirmationRequests)
		.where(eq(confirmationRequests.candidateId, stepan.candidateId));
	if (!asked) {
		const block = (await requestableBlocks(db, stepan.candidateId))[0];
		if (!block) throw new Error('К-1 has no block a company may ask to confirm');
		const member = sender(main);
		const [need] = await db
			.select({ id: hiringNeeds.id })
			.from(hiringNeeds)
			.where(eq(hiringNeeds.companyId, main.id))
			.orderBy(asc(hiringNeeds.createdAt))
			.limit(1);
		await requestConfirmation(deps, await subjectOf(ctx, member.userId), metaOf(ctx, member.userId), {
			candidateId: stepan.candidateId,
			block: block.block,
			needId: need?.id ?? null
		});
	}
	return true;
}
