// What the PDF profile of a candidate is made of (docs/domain.md, section 12.9), read for the candidate only: their own
// fields, the categories in force with their confirmations (issued here when missing), the stack by how it is known,
// the experience of the current resume and the one stated by hand, the FSP achievements with their own receipts and
// the soft skills. The file is the candidate's to hand over: the platform keeps no copy; the journal records that it
// was made and which confirmations it carries.
import type { AccessSubject } from '$lib/server/access/permissions';
import { categoryTitle } from '$lib/server/attestations/statement';
import { ensureAttestations } from '$lib/server/attestations/issue';
import { recordAuditEvent } from '$lib/server/audit/record';
import { awardName, factTitle } from '$lib/components/candidate/model';
import { periodText, parseQuotes } from '$lib/components/candidate/quotes';
import { loadSelfEvidence } from '$lib/server/candidates/profile';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { CATALOG, blockDefinition, gradeDefinition } from '$lib/server/assessments/contract/catalog';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database } from '$lib/server/db';
import { ApiError } from '$lib/server/errors/api-error';
import type { ReceiptSigner } from '$lib/server/fsp/receipts';
import { monthsText } from '$lib/server/grades/hint';
import { currentDeclaration } from '$lib/server/grades/policy';
import { surveyHistory } from '$lib/server/grades/surveys';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { readOwnResumes } from '$lib/server/resumes/read';
import { selfCandidate } from '$lib/server/resumes/deps';
import { ATTESTATION_LIMITS } from '$lib/server/attestations/statement';
import { fullNameText } from './contacts';
import { experienceMonths, listManualExperience } from './experience';
import { readOwnProfile } from './fields';
import type { ProfilePdfExperience, ProfilePdfInput } from './pdf';
import { softSkillName } from './soft-skills';

export interface ProfilePdfDeps {
	db: Database;
	crypto: FieldCrypto;
	signer: ReceiptSigner;
	now: () => Date;
}

/** Which contacts of the profile the candidate puts on the page; the name is always there. */
export interface PdfChoice {
	phone: boolean;
	email: boolean;
	telegram: boolean;
}

const monthFormat = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const monthText = (month: string) => monthFormat.format(new Date(`${month}-01T00:00:00Z`));

/** The address of the public check of a confirmation. */
export const attestationUrl = (origin: string, handle: string) => `${origin}/verify/categories/${handle}`;

/**
 * The input of the PDF for the candidate of the subject; issues the missing confirmations of the categories in force.
 * A profile without a name is refused: the holder commitment of a confirmation is made of it (domain 12.9).
 */
export async function buildProfilePdf(
	deps: ProfilePdfDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	choice: PdfChoice
): Promise<ProfilePdfInput> {
	const { candidateId } = selfCandidate(subject);
	const now = deps.now();
	const profile = await readOwnProfile(deps.db, deps.crypto, candidateId);
	if (profile.fullName === null) {
		throw new ApiError('conflict', {
			message: 'Укажите фамилию и имя в профиле: без них PDF-профиль не формируется',
			details: [{ code: 'profile_name_required', message: 'Нет фамилии и имени' }]
		});
	}
	const holder = profile.fullName;
	const vocabulary = await currentCandidateVocabulary(deps.db);
	if (!vocabulary) throw new ApiError('degraded', { message: 'Справочники ещё не опубликованы' });
	const labels = vocabularyLabels(vocabulary);
	const skillName = (key: string) => labels.skills[key] ?? key;
	const roleName = (key: string | null) => (key === null ? null : (labels.roles[key] ?? key));

	const attestations = await deps.db.transaction(async (tx) => {
		await requireProcessingConsent(tx, candidateId, now);
		const issued = await ensureAttestations(tx, deps.signer, { candidateId, holder, now });
		await recordAuditEvent(tx, {
			action: 'profile.pdf_issued',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'candidate', id: candidateId },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: {
				attestations: issued.map((item) => item.handle),
				issued: issued.filter((item) => item.issued).length
			},
			occurredAt: now
		});
		return issued;
	});

	const [surveys, own, evidence, manual] = await Promise.all([
		surveyHistory(deps.db, candidateId),
		readOwnResumes(deps.db, subject),
		loadSelfEvidence(deps.db, subject, now),
		listManualExperience(deps.db, candidateId)
	]);
	const survey = surveys.at(-1) ?? null;
	const declaration = survey === null ? null : await currentDeclaration(deps.db, candidateId, survey.specialization);

	const categories = attestations.map(({ category, handle, judgementNote }) => {
		const title = categoryTitle(category.specialization, category.grade);
		return {
			title: `${title.specialization} · ${title.grade}`,
			blocks: category.confirmedBlocks.map((code) => blockDefinition(code).title),
			skills: category.confirmedSkillKeys.map(skillName),
			decidedOn: dayFormat.format(category.assignedAt),
			catalogVersion: category.catalogVersion,
			bankReleaseId: category.bankReleaseId,
			verifyUrl: attestationUrl(deps.signer.issuer, handle),
			judgementNote,
			doesNotAssert: [
				...CATALOG.commonDoesNotCheck,
				...gradeDefinition(category.specialization, category.grade).doesNotCheck,
				...ATTESTATION_LIMITS
			]
		};
	});
	let withoutCategory: string | null = null;
	if (categories.length === 0) {
		const declared =
			declaration === null || survey === null
				? null
				: (() => {
						const title = categoryTitle(survey.specialization, declaration.grade);
						return `${title.specialization} · ${title.grade}`;
					})();
		withoutCategory =
			declared === null
				? 'Категория не подтверждена тестом платформы.'
				: `Категория не подтверждена тестом платформы. Заявленный грейд: ${declared}.`;
	}

	const confirmed = new Set(attestations.flatMap(({ category }) => category.confirmedSkillKeys));
	const declared = (survey?.declaredSkillKeys ?? []).filter((key) => !confirmed.has(key));
	const resumeSkills = [
		...new Set(
			(own.current?.claims ?? [])
				.filter(
					(claim) =>
						claim.claimType === 'skill_mention' &&
						claim.polarity === 'asserted' &&
						claim.candidateReview !== 'rejected' &&
						claim.skillKey !== null
				)
				.flatMap((claim) => (claim.skillKey === null ? [] : [claim.skillKey]))
		)
	].filter((key) => !confirmed.has(key) && !declared.includes(key));

	const experience: ProfilePdfExperience[] = [
		...(own.current?.experience ?? [])
			.filter((entry) => entry.candidateReview !== 'rejected')
			.map((entry) => {
				const period = periodText({ ...entry, quotes: parseQuotes(entry.quotes), sourceKey: `entry:${entry.id}` });
				return {
					title: entry.positionTitle ?? roleName(entry.roleKey) ?? 'Должность не указана',
					organization: entry.organizationName,
					period: period ?? 'период не указан',
					skills: entry.appliedSkillKeys.map(skillName),
					source: 'resume' as const
				};
			}),
		...manual.map((entry) => ({
			title: entry.positionTitle,
			organization: entry.organizationName,
			period: `${monthText(entry.periodFrom)} — ${entry.periodTo === null ? 'по настоящее время' : monthText(entry.periodTo)}`,
			skills: entry.skillKeys.map(skillName),
			source: 'stated' as const
		}))
	];
	const statedMonths = experienceMonths(manual, now);

	const achievements = evidence.facts
		.filter((fact) => fact.source === 'fsp' && fact.status === 'active')
		.map((fact) => {
			const { detail } = fact;
			return {
				title: factTitle(detail),
				detail:
					detail.kind === 'competition_result'
						? [awardName(detail.award), detail.place === null ? null : `${detail.place} место`]
								.filter((part) => part !== null)
								.join(', ')
						: null,
				place: detail.kind === 'competition_result' ? detail.place : null,
				receiptUrl: fact.receipt === null ? null : `${deps.signer.issuer}/verify/${fact.receipt.handle}`
			};
		});

	const contacts: { label: string; value: string }[] = [];
	if (choice.phone && profile.phone !== null) contacts.push({ label: 'Телефон', value: profile.phone });
	if (choice.email) contacts.push({ label: 'Почта', value: profile.email });
	if (choice.telegram && profile.telegram !== null) contacts.push({ label: 'Telegram', value: profile.telegram });

	return {
		name: fullNameText(holder),
		headline: profile.headline,
		contacts,
		categories,
		withoutCategory,
		stack: {
			confirmed: [...confirmed].map(skillName),
			declared: declared.map(skillName),
			resume: resumeSkills.map(skillName)
		},
		experience,
		experienceTotal: manual.length > 0 ? `Стаж по местам работы, указанным вручную: ${monthsText(statedMonths)}` : null,
		achievements,
		softSkills: profile.softSkillKeys.map(softSkillName),
		issuedOn: dayFormat.format(now),
		origin: deps.signer.issuer
	};
}
