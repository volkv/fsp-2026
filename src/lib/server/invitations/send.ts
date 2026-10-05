// Sending an offer (docs/domain.md, sections 5.1, 13.5): the first version, a revision and a reopening are the same act —
// a new immutable version of the terms of the one line of offers of a company to a candidate. Every version requires
// the admission policy of the company, its filled-in profile, the candidate visible in the catalog context (of the
// vacancy the version names, if any), a text without blocked requirements and a range in roubles. Withdrawal by the
// company and by the system closes an unanswered offer.
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { activeCategories } from '$lib/server/categories/read';
import { primarySpecializationOfRole } from '$lib/server/categories/roles';
import { loadCompanyAdmission, admissionRefusal } from '$lib/server/companies/gate';
import { loadCompanyProfile } from '$lib/server/companies/public-profile';
import type { Transaction } from '$lib/server/db';
import {
	candidates,
	hiringNeeds,
	invitations,
	invitationTerms,
	sourceFacts,
	verificationReceipts
} from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { notify } from '$lib/server/notifications/notify';
import { compareSalary } from '$lib/server/salary/compare';
import { isInvitable, type Invitability } from '$lib/server/vacancies/invitable';
import { checkVacancyText, type TextCheck } from '$lib/server/vacancies/text-check';
import { auditActor, type InvitationDeps, type RequestMeta } from './deps';
import { invalid, refuse, violation } from './errors';
import { policyById, requiredPolicy, type PolicyVersion } from './policies';
import {
	journalRefusal,
	lockInvitation,
	loadVacancy,
	memberSide,
	termsFacts,
	termsHistory,
	type InvitationRow,
	type MemberSide,
	type VacancyRow
} from './records';
import { cancelTermsJobs, scheduleTermsJobs } from './schedule';
import {
	CONTACT_KINDS,
	DESCRIPTION_MAX,
	DESCRIPTION_MIN,
	MESSAGE_MAX,
	OFFER_WORK_FORMATS,
	PREFERENCE_REFS,
	TITLE_MAX,
	WHY_YOU_MAX,
	WHY_YOU_MIN,
	WHY_YOU_SOURCES,
	WHY_YOU_TEXT_MAX,
	salaryTerms,
	termsChanges,
	vacancySnapshotOf,
	type CategorySnapshot,
	type ContactMethod,
	type TermsChanges,
	type TermsContent,
	type WhyYouPoint
} from './terms';
import { showInOfferContext } from './visibility';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONTACT_VALUE_MAX = 200;
const CONTACT_NOTE_MAX = 500;
const SOURCE_REF_MAX = 200;

/** What the employer writes in a version; currency and tax base are checked here, not trusted. */
export interface OfferInput {
	title: string;
	description: string;
	salaryMin: number;
	salaryMax: number;
	salaryCurrency: string;
	salaryTaxBase: string;
	workFormat: string;
	contactMethod: { kind: string; value: string; note?: string | null };
	whyYou: readonly { text: string; source: { kind: string; ref: string; receipt_handle?: string } }[];
	/** An own published vacancy of the company, by choice. */
	vacancyId?: string | null;
	message?: string | null;
}

/** The input after the checks that need no database. */
interface ValidOffer extends Omit<TermsContent, 'vacancy' | 'category'> {
	vacancyId: string | null;
}

const trimmed = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

function validContact(input: OfferInput['contactMethod']): ContactMethod {
	const kind = CONTACT_KINDS.find((known) => known === input.kind);
	if (!kind) throw invalid('contact_method.kind', 'Способ связи: почта, телефон, Telegram или другой');
	const value = trimmed(input.value);
	if (value === null || value.length > CONTACT_VALUE_MAX) {
		throw invalid('contact_method.value', `Контакт компании — от 1 до ${CONTACT_VALUE_MAX} символов`);
	}
	const note = trimmed(input.note);
	if (note !== null && note.length > CONTACT_NOTE_MAX) {
		throw invalid('contact_method.note', `Пояснение — не длиннее ${CONTACT_NOTE_MAX} символов`);
	}
	return { kind, value, note };
}

/** The shape of «why you»: 1–5 points, each with a text and a source; a point without a source is not kept. */
function validWhyYou(points: OfferInput['whyYou']): WhyYouPoint[] {
	if (points.length < WHY_YOU_MIN || points.length > WHY_YOU_MAX) {
		throw invalid('why_you', `«Почему вы» — от ${WHY_YOU_MIN} до ${WHY_YOU_MAX} пунктов`);
	}
	return points.map((point, index) => {
		const text = trimmed(point.text);
		if (text === null || text.length > WHY_YOU_TEXT_MAX) {
			throw invalid(`why_you.${index}.text`, `Пункт — от 1 до ${WHY_YOU_TEXT_MAX} символов`);
		}
		const kind = WHY_YOU_SOURCES.find((known) => known === point.source.kind);
		if (!kind) throw invalid(`why_you.${index}.source.kind`, 'Неизвестный источник пункта');
		const ref = trimmed(point.source.ref);
		if (ref === null || ref.length > SOURCE_REF_MAX) {
			throw invalid(`why_you.${index}.source.ref`, 'У пункта нет источника');
		}
		const handle = trimmed(point.source.receipt_handle);
		return { text, source: { kind, ref, ...(handle === null ? {} : { receipt_handle: handle }) } };
	});
}

function validOffer(input: OfferInput): ValidOffer {
	const title = trimmed(input.title);
	if (title === null || title.length > TITLE_MAX) throw invalid('title', `Название — от 1 до ${TITLE_MAX} символов`);
	const description = trimmed(input.description);
	if (description === null || description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
		throw invalid('description', `Описание — от ${DESCRIPTION_MIN} до ${DESCRIPTION_MAX} символов`);
	}
	if (!Number.isSafeInteger(input.salaryMin) || input.salaryMin <= 0) {
		throw invalid('salary_min', 'Нижняя граница — целое положительное число');
	}
	if (!Number.isSafeInteger(input.salaryMax) || input.salaryMax < input.salaryMin) {
		throw invalid('salary_max', 'Верхняя граница — целое число не меньше нижней');
	}
	// Only roubles (domain 13.5): another currency is a rule of the platform, not a malformed request.
	if (input.salaryCurrency !== 'RUB') throw violation('salary_not_rub', 'salary_currency');
	const taxBase = input.salaryTaxBase === 'gross' || input.salaryTaxBase === 'net' ? input.salaryTaxBase : null;
	if (taxBase === null) throw invalid('salary_tax_base', 'Налоговая база: до вычета НДФЛ или на руки');
	const workFormat = OFFER_WORK_FORMATS.find((known) => known === input.workFormat);
	if (!workFormat) throw invalid('work_format', 'Формат работы: офис, гибрид или удалённо');
	const message = trimmed(input.message);
	if (message !== null && message.length > MESSAGE_MAX) {
		throw invalid('message', `Сообщение длиннее ${MESSAGE_MAX} символов`);
	}
	return {
		title,
		description,
		vacancyId: trimmed(input.vacancyId),
		salary: { min: input.salaryMin, max: input.salaryMax, currency: 'RUB', period: 'month', taxBase },
		workFormat,
		contactMethod: validContact(input.contactMethod),
		whyYou: validWhyYou(input.whyYou),
		message
	};
}

/**
 * Every point of «why you» rests on what the company sees in the profile. An FSP result is named by the receipt the
 * company was issued for this candidate; a preference by the key the card shows. Sources of the test, of a confirmation
 * and of a challenge solution are accepted once their modules connect them to offers.
 */
async function checkSources(
	tx: Transaction,
	points: readonly WhyYouPoint[],
	pair: { candidateId: string; companyId: string }
): Promise<void> {
	for (const [index, point] of points.entries()) {
		const path = `why_you.${index}.source`;
		switch (point.source.kind) {
			case 'fsp_fact': {
				const handle = point.source.receipt_handle;
				if (handle === undefined) throw invalid(`${path}.receipt_handle`, 'Результат ФСП называется квитанцией');
				const [receipt] = await tx
					.select({ id: verificationReceipts.id })
					.from(verificationReceipts)
					.innerJoin(sourceFacts, eq(sourceFacts.id, verificationReceipts.factId))
					.where(
						and(
							eq(verificationReceipts.handle, handle),
							eq(verificationReceipts.audienceCompanyId, pair.companyId),
							eq(sourceFacts.candidateId, pair.candidateId)
						)
					);
				if (!receipt) throw invalid(`${path}.receipt_handle`, 'Квитанция не выдана компании об этом кандидате');
				break;
			}
			case 'preference':
				if (!(PREFERENCE_REFS as readonly string[]).includes(point.source.ref)) {
					throw invalid(`${path}.ref`, 'Предпочтение кандидата не из карточки');
				}
				break;
			case 'declared_skill':
				if (!/^[a-z0-9_]+$/u.test(point.source.ref)) throw invalid(`${path}.ref`, 'Навык называется ключом');
				break;
			case 'test_block':
			case 'confirmation':
			case 'challenge_solution':
				throw invalid(`${path}.kind`, 'Этот источник пока не подключён к предложениям');
		}
	}
}

/** Description, line of business and the text check of the version (domain 13.5): blocked text is not sent. */
function checkText(offer: ValidOffer): TextCheck {
	const check = checkVacancyText({ title: offer.title, description: offer.description, message: offer.message });
	if (check.result === 'blocked') throw violation('text_blocked', 'description');
	return check;
}

interface Authorized {
	vacancy: VacancyRow | null;
	invitability: Invitability | null;
}

/**
 * The checks of every sent version, in the order that gives each refusal its own code: the admission policy (`403`
 * with `company_suspended` / `company_rejected`), the profile (`422 company_profile_incomplete`), another company's
 * vacancy (`404`), an external or not invitable vacancy (`422 vacancy_not_invitable`), a range below the vacancy
 * (`422 salary_below_vacancy`), a candidate the company does not see in the context (`404`, whatever the reason).
 */
async function authorizeSending(
	tx: Transaction,
	subject: AccessSubject,
	member: MemberSide,
	offer: ValidOffer,
	candidateId: string,
	now: Date
): Promise<Authorized> {
	// Read in this transaction with the row locked: a suspension running at the same time is ordered with the sending.
	const admission = await loadCompanyAdmission(tx, member.companyId, { forUpdate: true });
	if (!admission.admitted) throw admissionRefusal(admission.reason);
	if (!(await loadCompanyProfile(tx, member.companyId)).complete) throw violation('company_profile_incomplete');

	let vacancy: VacancyRow | null = null;
	let invitability: Invitability | null = null;
	if (offer.vacancyId !== null) {
		vacancy = await loadVacancy(tx, offer.vacancyId);
		if (!vacancy || (vacancy.origin === 'own' && vacancy.companyId !== member.companyId)) {
			throw refuse('not_found', 'foreign_vacancy');
		}
		invitability = isInvitable(vacancy);
		if (!invitability.invitable) throw violation('vacancy_not_invitable', 'vacancy_id');
		// The lower bound is not below the range of the vacancy, when the two are comparable (domain 13.5).
		const vacancyRange = {
			min: vacancy.salaryMin,
			max: vacancy.salaryMax,
			currency: vacancy.salaryCurrency,
			period: vacancy.salaryPeriod,
			taxBase: vacancy.salaryTaxBase
		};
		if (
			compareSalary(salaryTerms(offer.salary), vacancyRange) !== 'not_comparable' &&
			vacancy.salaryMin !== null &&
			offer.salary.min < vacancy.salaryMin
		) {
			throw violation('salary_below_vacancy', 'salary_min');
		}
	}

	const { decision } = await showInOfferContext(tx, subject, candidateId, vacancy, now);
	if (!decision.allowed) throw refuse('not_found', decision.reason);
	const access = can(subject, 'invitation.create', { invitability, show: decision });
	if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
	await checkSources(tx, offer.whyYou, { candidateId, companyId: member.companyId });
	return { vacancy, invitability };
}

async function candidateUserId(tx: Transaction, candidateId: string): Promise<string> {
	const [row] = await tx.select({ userId: candidates.userId }).from(candidates).where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	return row.userId;
}

/**
 * The category of the candidate at this moment, recorded in the version (domain 13.5); `null` — none confirmed. Of
 * several categories (different specializations) the one of the specialization of the vacancy's role, when the offer
 * names a vacancy; otherwise the earliest assigned.
 */
async function categoryAt(
	tx: Transaction,
	candidateId: string,
	vacancy: VacancyRow | null
): Promise<CategorySnapshot | null> {
	const categories = (await activeCategories(tx, [candidateId])).get(candidateId) ?? [];
	const wanted = vacancy?.roleKey ? primarySpecializationOfRole(vacancy.roleKey) : null;
	const chosen = categories.find((category) => category.specialization === wanted) ?? categories[0];
	return chosen ? { specialization: chosen.specialization, grade: chosen.grade } : null;
}

interface VersionInput {
	termsId: string;
	invitationId: string;
	version: number;
	content: TermsContent;
	textCheck: TextCheck;
	changes: TermsChanges | null;
	responseDueAt: Date;
	memberId: string;
	now: Date;
}

async function insertVersion(tx: Transaction, input: VersionInput): Promise<void> {
	const { content } = input;
	await tx.insert(invitationTerms).values({
		id: input.termsId,
		invitationId: input.invitationId,
		version: input.version,
		title: content.title,
		description: content.description,
		vacancyId: content.vacancy?.id ?? null,
		vacancySnapshot: content.vacancy?.snapshot ?? null,
		category: content.category,
		salaryMin: content.salary.min,
		salaryMax: content.salary.max,
		salaryCurrency: content.salary.currency,
		salaryPeriod: content.salary.period,
		salaryTaxBase: content.salary.taxBase,
		workFormat: content.workFormat,
		contactMethod: content.contactMethod,
		whyYou: content.whyYou,
		message: content.message,
		textCheck: input.textCheck,
		responseDueAt: input.responseDueAt,
		changes: input.changes,
		createdByMemberId: input.memberId,
		createdAt: input.now
	});
}

export interface CreateInvitationInput extends OfferInput {
	candidateId: string;
	/** The need of the company the offer is sent from (domain 13.10). */
	needId?: string | null;
}

export interface SentTerms {
	invitationId: string;
	termsId: string;
	version: number;
	responseDueAt: Date;
}

const OPEN_STATUSES = ['sent', 'viewed'] as const;
const CLOSED_STATUSES = ['declined', 'expired', 'withdrawn'] as const;

/** `409 conflict` (`offer_open`): the pair already has an offer that is open or accepted; it is revised, not resent. */
function offerOpen(invitationId: string) {
	return refuse('conflict', 'offer_open', [
		{
			path: 'candidate_pseudonym',
			code: 'offer_open',
			message: `У компании уже есть предложение этому кандидату: ${invitationId}`
		}
	]);
}

/**
 * Sends an offer of the subject's company to the candidate. The first offer creates the one line of the pair; after a
 * declined, expired or withdrawn offer it is a reopening — a new version of the same line after the cooldown; an open
 * or accepted offer is revised by `reviseInvitation`, so sending again is `409 offer_open`.
 */
export async function createInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: CreateInvitationInput
): Promise<SentTerms> {
	const offer = validOffer(input);
	return journalRefusal(
		deps.db,
		subject,
		meta,
		{ action: 'invitation.sent', subjectCandidateId: input.candidateId, side: 'company' },
		() =>
			deps.db.transaction(async (tx) => {
				const now = deps.now();
				const member = memberSide(subject);
				const authorized = await authorizeSending(tx, subject, member, offer, input.candidateId, now);
				const textCheck = checkText(offer);
				const needId = trimmed(input.needId);
				if (needId !== null) {
					const [need] = await tx
						.select({ id: hiringNeeds.id })
						.from(hiringNeeds)
						.where(and(eq(hiringNeeds.id, needId), eq(hiringNeeds.companyId, member.companyId)));
					if (!need) throw refuse('not_found', 'foreign_need');
				}

				const [existing] = await tx
					.select()
					.from(invitations)
					.where(and(eq(invitations.companyId, member.companyId), eq(invitations.candidateId, input.candidateId)))
					.for('update');
				if (existing && existing.purgedAt === null) {
					if (!(CLOSED_STATUSES as readonly string[]).includes(existing.status)) throw offerOpen(existing.id);
					return sendVersion(tx, subject, meta, existing, offer, authorized, textCheck, now);
				}
				if (existing) throw offerOpen(existing.id);

				const policy = await requiredPolicy(tx, 'invitation_policy', now);
				await checkDailyLimit(tx, member.companyId, policy, now);
				const content: TermsContent = {
					...offer,
					vacancy: authorized.vacancy && { id: authorized.vacancy.id, snapshot: vacancySnapshotOf(authorized.vacancy) },
					category: await categoryAt(tx, input.candidateId, authorized.vacancy)
				};
				const invitationId = uuidv7();
				const termsId = uuidv7();
				const responseDueAt = new Date(now.getTime() + policy.params.response_window_hours * HOUR);
				const inserted = await tx
					.insert(invitations)
					.values({
						id: invitationId,
						companyId: member.companyId,
						candidateId: input.candidateId,
						sentByMemberId: member.memberId,
						status: 'sent',
						currentTermsId: termsId,
						needId,
						policyId: policy.id,
						sentAt: now
					})
					.onConflictDoNothing({ target: [invitations.companyId, invitations.candidateId] })
					.returning({ id: invitations.id });
				// A concurrent first offer of the same pair committed in between: there is one line per pair.
				if (inserted.length === 0) throw refuse('conflict', 'offer_open');
				await insertVersion(tx, {
					termsId,
					invitationId,
					version: 1,
					content,
					textCheck,
					changes: null,
					responseDueAt,
					memberId: member.memberId,
					now
				});

				await scheduleTermsJobs(tx, { id: termsId, responseDueAt }, now, { kind: 'user', id: member.userId });
				await notify(tx, {
					userId: await candidateUserId(tx, input.candidateId),
					type: 'invitation.received',
					objectId: invitationId,
					payload: { invitation_id: invitationId, terms_id: termsId }
				});
				await recordAuditEvent(tx, {
					action: 'invitation.sent',
					outcome: 'success',
					actor: auditActor(subject, meta, 'company'),
					object: { type: 'invitation', id: invitationId },
					subjectCandidateId: input.candidateId,
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					details: {
						vacancy_id: content.vacancy?.id ?? null,
						need_id: needId,
						terms_id: termsId,
						version: 1,
						text_check: textCheck.result
					},
					occurredAt: now
				});
				return { invitationId, termsId, version: 1, responseDueAt };
			})
	);
}

/** New lines of offers of the company over the last day, against `max_open_per_company_per_day`. */
async function checkDailyLimit(
	tx: Transaction,
	companyId: string,
	policy: PolicyVersion<'invitation_policy'>,
	now: Date
): Promise<void> {
	const [sentToday] = await tx
		.select({ value: count() })
		.from(invitations)
		.where(and(eq(invitations.companyId, companyId), gt(invitations.sentAt, new Date(now.getTime() - DAY))));
	if ((sentToday?.value ?? 0) >= policy.params.max_open_per_company_per_day) {
		throw refuse('rate_limited', 'daily_invitation_limit');
	}
}

export interface RevisedTerms extends SentTerms {
	changes: TermsChanges;
	reopened: boolean;
}

/**
 * A new version of an existing line: a revision of an open or accepted offer, or a reopening of a declined, expired
 * or withdrawn one after the cooldown of its policy. The previous version stops being answerable, and an accepted offer
 * keeps its accepted version until the candidate answers the new one.
 */
async function sendVersion(
	tx: Transaction,
	subject: AccessSubject,
	meta: RequestMeta,
	invitation: InvitationRow,
	offer: ValidOffer,
	authorized: Authorized,
	textCheck: TextCheck,
	now: Date
): Promise<RevisedTerms> {
	const member = memberSide(subject);
	const policy = await policyById(tx, 'invitation_policy', invitation.policyId);
	const reopened = (CLOSED_STATUSES as readonly string[]).includes(invitation.status);
	if (reopened) {
		if (invitation.reopenCount >= policy.params.max_reopens) throw refuse('conflict', 'reopen_limit');
		const closedAt = invitation.closedAt ?? invitation.sentAt;
		if (now.getTime() < closedAt.getTime() + policy.params.reopen_cooldown_days * DAY) {
			throw violation('reopen_cooldown');
		}
	}
	const access = can(subject, 'invitation.revise', { companyId: invitation.companyId, revisable: true });
	if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);

	const history = await termsHistory(tx, invitation.id);
	const content: TermsContent = {
		...offer,
		vacancy: authorized.vacancy && { id: authorized.vacancy.id, snapshot: vacancySnapshotOf(authorized.vacancy) },
		category: await categoryAt(tx, invitation.candidateId, authorized.vacancy)
	};
	const changes = termsChanges(content, history.map(termsFacts));
	const version = changes.previous_version + 1;
	const responseDueAt = new Date(now.getTime() + policy.params.response_window_hours * HOUR);
	const termsId = uuidv7();
	await insertVersion(tx, {
		termsId,
		invitationId: invitation.id,
		version,
		content,
		textCheck,
		changes,
		responseDueAt,
		memberId: member.memberId,
		now
	});
	await tx
		.update(invitations)
		.set({
			currentTermsId: termsId,
			// An accepted offer stays accepted with its accepted version until the new one is answered.
			status: invitation.status === 'accepted' ? 'accepted' : 'sent',
			...(reopened ? { closedAt: null, reopenCount: invitation.reopenCount + 1 } : {})
		})
		.where(eq(invitations.id, invitation.id));

	if (invitation.currentTermsId !== null) await cancelTermsJobs(tx, invitation.currentTermsId);
	await scheduleTermsJobs(tx, { id: termsId, responseDueAt }, now, { kind: 'user', id: member.userId });
	await notify(tx, {
		userId: await candidateUserId(tx, invitation.candidateId),
		type: 'invitation.terms_revised',
		objectId: invitation.id,
		stage: `v${version}`,
		payload: {
			invitation_id: invitation.id,
			terms_id: termsId,
			version,
			salary_lowered: changes.salary_lowered,
			reopened
		}
	});
	const journal = {
		actor: auditActor(subject, meta, 'company'),
		object: { type: 'invitation', id: invitation.id },
		subjectCandidateId: invitation.candidateId,
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		occurredAt: now
	};
	await recordAuditEvent(tx, {
		...journal,
		action: 'invitation.terms_revised',
		outcome: 'success',
		details: { salary_lowered: changes.salary_lowered, terms_id: termsId, version, text_check: textCheck.result }
	});
	if (reopened) {
		await recordAuditEvent(tx, {
			...journal,
			action: 'invitation.reopened',
			outcome: 'success',
			details: { reopen_count: invitation.reopenCount + 1, terms_id: termsId }
		});
	}
	return { invitationId: invitation.id, termsId, version, responseDueAt, changes, reopened };
}

/** A new version of the terms of an offer of the subject's company: a revision or, after the cooldown, a reopening. */
export async function reviseInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string,
	input: OfferInput
): Promise<RevisedTerms> {
	const offer = validOffer(input);
	return journalRefusal(
		deps.db,
		subject,
		meta,
		{ action: 'invitation.sent', object: { type: 'invitation', id: invitationId }, side: 'company' },
		() =>
			deps.db.transaction(async (tx) => {
				const now = deps.now();
				const member = memberSide(subject);
				const invitation = await lockInvitation(tx, invitationId);
				if (!invitation || invitation.companyId !== member.companyId) throw refuse('not_found', 'foreign_invitation');
				const authorized = await authorizeSending(tx, subject, member, offer, invitation.candidateId, now);
				const textCheck = checkText(offer);
				return sendVersion(tx, subject, meta, invitation, offer, authorized, textCheck, now);
			})
	);
}

/** Closes an unanswered offer and tells the candidate; the reason is journaled. */
async function closeAsWithdrawn(
	tx: Transaction,
	invitation: InvitationRow,
	now: Date,
	journal: { actor: Parameters<typeof recordAuditEvent>[1]['actor']; requestId: string; cause: string }
): Promise<void> {
	await tx.update(invitations).set({ status: 'withdrawn', closedAt: now }).where(eq(invitations.id, invitation.id));
	if (invitation.currentTermsId !== null) await cancelTermsJobs(tx, invitation.currentTermsId);
	await notify(tx, {
		userId: await candidateUserId(tx, invitation.candidateId),
		type: 'invitation.withdrawn',
		objectId: invitation.id,
		payload: { invitation_id: invitation.id, cause: journal.cause }
	});
	await recordAuditEvent(tx, {
		action: 'invitation.withdrawn',
		outcome: 'success',
		actor: journal.actor,
		object: { type: 'invitation', id: invitation.id },
		subjectCandidateId: invitation.candidateId,
		requestId: journal.requestId,
		details: { cause: journal.cause },
		occurredAt: now
	});
}

/** The company withdraws an offer the candidate has not answered. */
export async function withdrawInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string
): Promise<void> {
	await deps.db.transaction(async (tx) => {
		const now = deps.now();
		const member = memberSide(subject);
		const invitation = await lockInvitation(tx, invitationId);
		if (!invitation || invitation.companyId !== member.companyId) throw refuse('not_found', 'foreign_invitation');
		const access = can(subject, 'invitation.revise', { companyId: invitation.companyId, revisable: true });
		if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
		if (!(OPEN_STATUSES as readonly string[]).includes(invitation.status)) throw refuse('conflict', 'not_open');
		await closeAsWithdrawn(tx, invitation, now, {
			actor: auditActor(subject, meta, 'company'),
			requestId: meta.requestId,
			cause: 'company'
		});
	});
}

export type WithdrawalCause = 'company_suspended' | 'company_rejected' | 'vacancy_closed' | 'account_deleted';

/**
 * Withdraws every unanswered offer of a company, of a vacancy (the current version names it) or of a candidate in the
 * caller's transaction: the admission policy closed the company, the vacancy was closed, the account is being deleted
 * (domain 5.1, 13.5, 19.1). Accepted offers stay: their hiring processes live on. Returns how many were withdrawn.
 */
export async function withdrawOpenInvitations(
	tx: Transaction,
	scope: { companyId: string } | { vacancyId: string } | { candidateId: string },
	cause: WithdrawalCause,
	journal: { requestId: string; at: Date }
): Promise<number> {
	const where =
		'companyId' in scope
			? eq(invitations.companyId, scope.companyId)
			: 'vacancyId' in scope
				? inArray(
						invitations.currentTermsId,
						tx
							.select({ id: invitationTerms.id })
							.from(invitationTerms)
							.where(eq(invitationTerms.vacancyId, scope.vacancyId))
					)
				: eq(invitations.candidateId, scope.candidateId);
	const open = await tx
		.select()
		.from(invitations)
		.where(and(where, inArray(invitations.status, [...OPEN_STATUSES]), sql`${invitations.purgedAt} is null`))
		.for('update');
	for (const invitation of open) {
		if (cause === 'account_deleted') {
			await tx
				.update(invitations)
				.set({ status: 'withdrawn', closedAt: journal.at })
				.where(eq(invitations.id, invitation.id));
			if (invitation.currentTermsId !== null) await cancelTermsJobs(tx, invitation.currentTermsId);
			await recordAuditEvent(tx, {
				action: 'invitation.withdrawn',
				outcome: 'success',
				actor: { kind: 'system' },
				object: { type: 'invitation', id: invitation.id },
				subjectCandidateId: invitation.candidateId,
				requestId: journal.requestId,
				details: { cause },
				occurredAt: journal.at
			});
			continue;
		}
		await closeAsWithdrawn(tx, invitation, journal.at, {
			actor: { kind: 'system' },
			requestId: journal.requestId,
			cause
		});
	}
	return open.length;
}
