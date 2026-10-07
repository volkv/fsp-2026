import { fail } from '@sveltejs/kit';
import type { AccessSubject } from '$lib/server/access/permissions';
import { SOURCE_FAILURES } from '$lib/components/candidate/model';
import { resumeFields, type QuoteSource } from '$lib/components/candidate/quotes';
import { authDeps } from '$lib/server/auth/context';
import { formText } from '$lib/server/auth/http';
import { fspIdentityOf } from '$lib/server/auth/identities';
import { candidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { loadSelfEvidence } from '$lib/server/candidates/profile';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { candidates } from '$lib/server/db/schema';
import { processingAllowed } from '$lib/server/consent/processing';
import { representativeOverview } from '$lib/server/consent/representative';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { ApiError } from '$lib/server/errors/api-error';
import { externalProfileDeps } from '$lib/server/external-profiles/deps';
import { readOwnExternalProfiles } from '$lib/server/external-profiles/read';
import {
	confirmLink,
	refreshOwnProfile,
	startLink,
	unlinkProfile,
	type ConfirmOutcome,
	type RefreshOutcome
} from '$lib/server/external-profiles/service';
import { PLATFORM_NAMES, type ExternalPlatform } from '$lib/server/external-profiles/types';
import { readOwnResumes } from '$lib/server/resumes/read';
import { currentCandidateVocabulary } from '$lib/server/candidates/vocabulary';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { addManualExperience, removeManualExperience, updateManualExperience } from '$lib/server/profile/experience';
import { decideSuggestion, updateOwnProfile } from '$lib/server/profile/fields';
import { MAX_SOFT_SKILLS, SOFT_SKILLS } from '$lib/server/profile/soft-skills';
import { ownProfileView } from '$lib/server/profile/view';
import { monthsText } from '$lib/server/grades/hint';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

/**
 * The state of the ground of processing the profile in a word: for 14–17 whether the legal representative's side came
 * in, for an adult whether the own consent is in force (after 18 it is signed again).
 */
async function consentState(
	candidateId: string,
	now: Date
): Promise<
	'effective' | 'representative_received' | 'representative_pending' | 'representative_missing' | 'own_missing'
> {
	const database = db();
	const allowed = await processingAllowed(database, candidateId, now);
	const [row] = await database
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row || !isMinorBand(ageBand(row, now))) return allowed ? 'effective' : 'own_missing';
	if (allowed) return 'representative_received';
	const overview = await representativeOverview(database, candidateId, now);
	return overview.representation === null ? 'representative_missing' : 'representative_pending';
}

/**
 * The current resume as the profile shows it: the file and where its reading stands, and once read, the extracted
 * fields with their quotes marked in the document text — and the quotes of the suggestions of profile fields, so a
 * suggestion opens the document at its words. Reviewing the fields is the resume page's business.
 */
async function currentResume(subject: AccessSubject, suggestions: readonly QuoteSource[]) {
	const { current } = await readOwnResumes(db(), subject);
	if (current === null) return null;
	const { upload, reading } = current;
	return {
		upload: {
			declaredName: upload.declaredName,
			parseStatus: upload.parseStatus,
			uploadedAt: upload.uploadedAt,
			failureMessage: upload.failureMessage
		},
		reading: reading === null ? null : { processingMode: reading.processingMode, model: reading.model },
		// The parse and the extraction run in the background: the fields come once the reading is known.
		inProgress:
			upload.parseStatus === 'pending' ||
			((upload.parseStatus === 'parsed' || upload.parseStatus === 'partial') && reading === null),
		...resumeFields(current, suggestions)
	};
}

/**
 * «Профиль собирается сам»: every fact of the profile by its source with its trust — FSP achievements, platform tests,
 * public profiles and the resume — and the skills with the facts behind them. Without linked achievements the page
 * says how to bring them: link FSP ID, then the separate import consent.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, userId, candidateId } = await candidateRequest(event);
	try {
		const now = new Date();
		const evidence = await loadSelfEvidence(db(), subject, now);
		let fspStep: 'import' | 'link' | 'unavailable' | null = null;
		if (!evidence.fspLinked) {
			const issuer = config().fspId?.issuer;
			if (issuer === undefined) fspStep = 'unavailable';
			else fspStep = (await fspIdentityOf(await authDeps(), userId, issuer)) ? 'import' : 'link';
		}
		const own = await ownProfileView({ db: db(), crypto: fieldCrypto(), now: () => now }, subject);
		const vocabulary = await currentCandidateVocabulary(db());
		return {
			evidence,
			fspStep,
			consent: await consentState(candidateId, now),
			externalProfiles: await readOwnExternalProfiles(db(), candidateId, now),
			resume: await currentResume(
				subject,
				own.suggestions.map((suggestion) => ({ key: suggestion.sourceKey, quotes: [suggestion.quote] }))
			),
			own: {
				profile: own.profile,
				experience: own.experience,
				experienceMonthsText: own.experience.length > 0 ? monthsText(own.experienceMonths) : null,
				suggestions: own.suggestions,
				attestations: own.attestations.map((attestation) => ({
					handle: attestation.handle,
					holderCode: attestation.holderCode,
					status: attestation.status,
					issuedAt: attestation.issuedAt,
					url: `${config().appOrigin}/verify/categories/${attestation.handle}`
				}))
			},
			softSkills: SOFT_SKILLS.map((skill) => ({ key: skill.key, name: skill.name })),
			maxSoftSkills: MAX_SOFT_SKILLS,
			skills: vocabulary?.skills ?? [],
			roles: vocabulary?.roles ?? []
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const PLATFORMS: readonly ExternalPlatform[] = ['codeforces', 'github'];

function platformOf(form: FormData): ExternalPlatform {
	const platform = PLATFORMS.find((value) => value === formText(form, 'platform'));
	if (!platform) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'platform', code: 'invalid_platform', message: 'Выберите Codeforces или GitHub' }]
		});
	}
	return platform;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function profileIdOf(form: FormData): string {
	const value = formText(form, 'profile_id');
	if (!UUID.test(value)) throw new ApiError('not_found');
	return value;
}

/** A refusal of an action on one profile, told next to that profile (or next to the link form). */
function targetFailure(cause: unknown, target: string) {
	const failure = formFailure(cause);
	return fail(failure.status, { ...failure.data, target });
}

function confirmMessage(platform: ExternalPlatform, outcome: ConfirmOutcome): { ok: boolean; text: string } {
	const name = PLATFORM_NAMES[platform];
	switch (outcome.kind) {
		case 'verified':
			if (outcome.sync === 'ok')
				return { ok: true, text: `Профиль ${name} подтверждён, данные профиля сверены. Код из профиля можно убрать.` };
			if (outcome.sync === 'not_found')
				return { ok: true, text: `Профиль ${name} подтверждён, но источник больше не находит аккаунт.` };
			return {
				ok: true,
				text: `Профиль ${name} подтверждён. Данные не сверены: ${name} ${outcome.reason === null ? 'недоступен' : SOURCE_FAILURES[outcome.reason]} — сверим позже сами.`
			};
		case 'code_not_found':
			return {
				ok: false,
				text: `Код не найден в профиле ${name}. Проверьте, что он сохранён и виден публично, и повторите.`
			};
		case 'handle_not_found':
			return { ok: false, text: `${name} не знает такого профиля. Проверьте написание.` };
		case 'handle_taken':
			return { ok: false, text: 'Этот профиль уже подтверждён другим пользователем платформы.' };
		case 'expired':
			return { ok: false, text: 'Срок кода истёк. Получите новый код.' };
		case 'attempts_exhausted':
			return { ok: false, text: 'Проверок этого кода больше не осталось. Получите новый код.' };
		case 'source_unavailable':
			return { ok: false, text: `Проверить не удалось: ${name} ${SOURCE_FAILURES[outcome.reason]}. Повторите позже.` };
	}
}

function refreshMessage(platform: ExternalPlatform, outcome: RefreshOutcome): { ok: boolean; text: string } {
	const name = PLATFORM_NAMES[platform];
	switch (outcome.kind) {
		case 'synced':
			return outcome.sync === 'ok'
				? { ok: true, text: `Данные ${name} сверены.` }
				: { ok: false, text: `${name} больше не находит аккаунт: его данные выведены из профиля.` };
		case 'source_unavailable':
			return {
				ok: false,
				text: `Сверить не удалось: ${name} ${SOURCE_FAILURES[outcome.reason]}. Данные профиля прежние.`
			};
		case 'stale':
			return { ok: false, text: 'Профиль изменился, пока шла сверка. Обновите страницу.' };
	}
}

const nullable = (value: string) => (value.trim() === '' ? null : value);
const MONTH_INPUT = /^\d{4}-\d{2}$/u;

/** The experience form as the service takes it; a month the browser did not send as `YYYY-MM` is refused there. */
function experienceInput(form: FormData) {
	const current = formText(form, 'is_current') === 'on';
	const from = formText(form, 'period_from');
	const to = formText(form, 'period_to');
	const problems: { path: string; code: string; message: string }[] = [];
	if (!MONTH_INPUT.test(from))
		problems.push({ path: 'period_from', code: 'invalid_month', message: 'Укажите месяц начала' });
	if (!current && !MONTH_INPUT.test(to)) {
		problems.push({
			path: 'period_to',
			code: 'invalid_month',
			message: 'Укажите месяц окончания или отметьте «работаю сейчас»'
		});
	}
	const title = formText(form, 'position_title').trim();
	if (title === '') problems.push({ path: 'position_title', code: 'required', message: 'Укажите должность' });
	if (problems.length > 0) throw new ApiError('validation_failed', { details: problems });
	return {
		position_title: title,
		organization_name: nullable(formText(form, 'organization_name')),
		role_key: nullable(formText(form, 'role_key')),
		period_from: from,
		period_to: current ? null : to,
		skill_keys: form.getAll('skill_keys').filter((value): value is string => typeof value === 'string'),
		description: nullable(formText(form, 'description'))
	};
}

const profileDeps = () => ({ db: db(), crypto: fieldCrypto(), now: () => new Date() });

export const actions: Actions = {
	saveProfile: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			const changed = await updateOwnProfile(profileDeps(), subject, meta, {
				last_name: nullable(formText(form, 'last_name')),
				first_name: nullable(formText(form, 'first_name')),
				middle_name: nullable(formText(form, 'middle_name')),
				phone: nullable(formText(form, 'phone')),
				telegram: nullable(formText(form, 'telegram')),
				headline: nullable(formText(form, 'headline')),
				soft_skill_keys: form.getAll('soft_skill_keys').filter((value): value is string => typeof value === 'string')
			});
			return { target: 'fields', saved: changed.length };
		} catch (cause) {
			return targetFailure(cause, 'fields');
		}
	},

	decideSuggestion: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const id = formText(form, 'suggestion_id');
		const decision = formText(form, 'decision');
		try {
			if (!UUID.test(id)) throw new ApiError('not_found');
			if (decision !== 'accepted' && decision !== 'rejected') {
				throw new ApiError('validation_failed', { message: 'Не выбрано решение' });
			}
			await decideSuggestion(profileDeps(), subject, meta, id, decision);
			return { target: `suggestion:${id}`, decided: decision };
		} catch (cause) {
			return targetFailure(cause, `suggestion:${id}`);
		}
	},

	addExperience: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await addManualExperience(profileDeps(), subject, meta, experienceInput(form));
			return { target: 'experience:new', experienceSaved: true };
		} catch (cause) {
			return targetFailure(cause, 'experience:new');
		}
	},

	updateExperience: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const id = formText(form, 'entry_id');
		try {
			if (!UUID.test(id)) throw new ApiError('not_found');
			await updateManualExperience(profileDeps(), subject, meta, id, experienceInput(form));
			return { target: `experience:${id}`, experienceSaved: true };
		} catch (cause) {
			return targetFailure(cause, `experience:${id}`);
		}
	},

	removeExperience: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const id = formText(form, 'entry_id');
		try {
			if (!UUID.test(id)) throw new ApiError('not_found');
			await removeManualExperience(profileDeps(), subject, meta, id);
			return { target: 'experience:new', experienceRemoved: true };
		} catch (cause) {
			return targetFailure(cause, `experience:${id}`);
		}
	},

	linkProfile: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			const platform = platformOf(form);
			await startLink(externalProfileDeps(), subject, { platform, handle: formText(form, 'handle') }, meta);
			return {
				target: 'link',
				message: { ok: true, text: 'Код выдан: добавьте его в профиль и нажмите «Проверить».' }
			};
		} catch (cause) {
			return targetFailure(cause, 'link');
		}
	},

	confirmProfile: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const target = `profile:${formText(form, 'profile_id')}`;
		try {
			const platform = platformOf(form);
			const outcome = await confirmLink(externalProfileDeps(), subject, profileIdOf(form), meta);
			return { target, message: confirmMessage(platform, outcome) };
		} catch (cause) {
			return targetFailure(cause, target);
		}
	},

	refreshProfile: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const target = `profile:${formText(form, 'profile_id')}`;
		try {
			const platform = platformOf(form);
			const outcome = await refreshOwnProfile(externalProfileDeps(), subject, profileIdOf(form), meta);
			return { target, message: refreshMessage(platform, outcome) };
		} catch (cause) {
			return targetFailure(cause, target);
		}
	},

	unlinkProfile: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const target = `profile:${formText(form, 'profile_id')}`;
		try {
			await unlinkProfile(externalProfileDeps(), subject, profileIdOf(form), meta);
			return { target: 'link', message: { ok: true, text: 'Профиль отвязан, его данные выведены из профиля.' } };
		} catch (cause) {
			return targetFailure(cause, target);
		}
	}
};
