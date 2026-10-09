import { fail } from '@sveltejs/kit';
import { resumeFields } from '$lib/components/candidate/quotes';
import { formText } from '$lib/server/http/form';
import { rateLimitedError } from '$lib/server/http/rate-limit';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { candidateRequest } from '$lib/server/candidates/http';
import { processingRefusal } from '$lib/server/consent/processing';
import { formFailure, pageError, type FormProblem } from '$lib/server/http/page';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { assertResumeSize } from '$lib/server/documents/limits';
import { ApiError } from '$lib/server/errors/api-error';
import { modelModes } from '$lib/server/ml';
import { extractRoute } from '$lib/server/ml/disclosure';
import { deleteResume } from '$lib/server/resumes/delete';
import { resumeDeps } from '$lib/server/resumes/deps';
import { readingFlags, readOwnResumes, resumeInProgress } from '$lib/server/resumes/read';
import { correctExperienceEntry, reviewExperienceEntry, reviewResumeClaim } from '$lib/server/resumes/review';
import { uploadResume } from '$lib/server/resumes/upload';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { decideSuggestion, readOwnProfile } from '$lib/server/profile/fields';
import { readSuggestions } from '$lib/server/profile/suggestions';
import type { Actions, PageServerLoad } from './$types';

/** Key the page invalidates while the resume is still being read. */
const RESUME_DEPENDENCY = 'app:me-resume';

/**
 * The candidate's resume: every upload with the state of its parse, and for the current one the document text with
 * the quotes of every extracted field and experience entry, how it was read, and what the candidate decided about it.
 */
export const load: PageServerLoad = async (event) => {
	event.depends(RESUME_DEPENDENCY);
	const { subject, candidateId } = await candidateRequest(event);
	try {
		const database = db();
		const [own, vocabulary, refusal] = await Promise.all([
			readOwnResumes(database, subject),
			currentCandidateVocabulary(database),
			processingRefusal(database, candidateId, new Date())
		]);
		const current = own.current;
		const document = current?.document ?? null;
		const crypto = fieldCrypto();
		const suggestions = document === null ? [] : await readSuggestions(database, crypto, candidateId, document);
		const fields =
			current === null
				? null
				: resumeFields(
						current,
						suggestions.map((suggestion) => ({ key: suggestion.sourceKey, quotes: [suggestion.quote] }))
					);
		return {
			/** Why a resume is not taken now; the upload form is replaced by the reason. */
			processingRefusal: refusal?.message ?? null,
			uploads: own.uploads,
			current:
				current === null || fields === null
					? null
					: {
							upload: current.upload,
							reading: current.reading,
							document:
								document === null || fields.document === null
									? null
									: { status: document.status, flags: readingFlags(document.flags), ...fields.document },
							claims: fields.claims,
							experience: fields.experience,
							suggestions
						},
			// The address of the account, to compare an address the resume gives with it.
			accountEmail: suggestions.some((suggestion) => suggestion.field === 'email')
				? (await readOwnProfile(database, crypto, candidateId)).email
				: null,
			// The parse and the extraction run in the background: the page asks again until the reading is known.
			inProgress: resumeInProgress(current),
			extractRoute: await extractRoute(config().models.extract, modelModes()),
			labels: vocabularyLabels(vocabulary),
			roles: vocabulary?.roles ?? []
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const DECISIONS = ['confirm', 'reject'] as const;

function decisionOf(form: FormData) {
	const decision = DECISIONS.find((value) => value === formText(form, 'decision'));
	if (!decision) throw new ApiError('validation_failed', { message: 'Не выбрано решение' });
	return decision;
}

/** A refusal of an action, told next to what it is about: the upload, the list, a field or an entry. */
function targetFailure(cause: unknown, target: string) {
	const failure = formFailure(cause);
	return fail(failure.status, { ...failure.data, target });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The identifier a form names; anything else names nothing of the candidate's. */
function idOf(form: FormData, name: string): string {
	const value = formText(form, name);
	if (!UUID.test(value)) throw new ApiError('not_found');
	return value;
}

const nullable = (value: string) => (value.trim() === '' ? null : value.trim());

const PERIOD_HINT = 'Год (2021) или год и месяц (2021-03)';

/** Field messages of the correction in the candidate's words; the service states them for the API. */
function correctionProblem(cause: unknown): FormProblem | null {
	if (!(cause instanceof ApiError) || cause.code !== 'validation_failed') return null;
	const fields: Record<string, string> = {};
	for (const detail of cause.details ?? []) {
		if (detail.path === undefined) continue;
		if (detail.path === 'positionTitle') fields.positionTitle = 'Должность — не длиннее 200 символов';
		else if (detail.path === 'organizationName') fields.organizationName = 'Компания — не длиннее 200 символов';
		else if (detail.path === 'roleKey') {
			fields.roleKey = detail.code === 'unknown_role' ? detail.message : 'Выберите роль из списка';
		} else if (detail.path === 'periodTo' && detail.code === 'custom') {
			fields.periodTo = 'У текущей работы нет даты окончания — очистите поле или снимите отметку';
		} else if (detail.path === 'periodFrom' || detail.path === 'periodTo') fields[detail.path] = PERIOD_HINT;
		else fields[detail.path] = detail.message;
	}
	return { message: 'Проверьте поля опыта', fields, code: 'validation_failed' };
}

export const actions: Actions = {
	upload: async (event) => {
		// Over the limit of paid parses the hook lets the post through, for the form to say so in its own words.
		if (event.locals.rateLimited) return targetFailure(rateLimitedError(event.locals.rateLimited), 'upload');
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, {
				problem: { message: 'Выберите файл резюме', fields: { file: 'Выберите файл резюме' }, code: 'empty' },
				target: 'upload'
			});
		}
		try {
			assertResumeSize(file.size);
			const bytes = new Uint8Array(await file.arrayBuffer());
			await uploadResume(resumeDeps(), subject, { bytes, declaredName: file.name }, meta);
		} catch (cause) {
			return targetFailure(cause, 'upload');
		}
		return { uploaded: true };
	},

	delete: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await deleteResume(resumeDeps(), subject, idOf(form, 'resume_document_id'), meta);
		} catch (cause) {
			return targetFailure(cause, 'delete');
		}
		return { deleted: true };
	},

	reviewClaim: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const claimId = formText(form, 'claim_id');
		try {
			await reviewResumeClaim(resumeDeps(), subject, idOf(form, 'claim_id'), decisionOf(form), meta);
		} catch (cause) {
			return targetFailure(cause, `claim:${claimId}`);
		}
		return { reviewed: `claim:${claimId}` };
	},

	decideSuggestion: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const suggestionId = formText(form, 'suggestion_id');
		const decision = formText(form, 'decision');
		try {
			if (decision !== 'accepted' && decision !== 'rejected') {
				throw new ApiError('validation_failed', { message: 'Не выбрано решение' });
			}
			await decideSuggestion(
				{ db: db(), crypto: fieldCrypto(), now: () => new Date() },
				subject,
				meta,
				idOf(form, 'suggestion_id'),
				decision
			);
		} catch (cause) {
			return targetFailure(cause, `suggestion:${suggestionId}`);
		}
		return { reviewed: `suggestion:${suggestionId}` };
	},

	reviewEntry: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const entryId = formText(form, 'entry_id');
		try {
			await reviewExperienceEntry(resumeDeps(), subject, idOf(form, 'entry_id'), decisionOf(form), meta);
		} catch (cause) {
			return targetFailure(cause, `entry:${entryId}`);
		}
		return { reviewed: `entry:${entryId}` };
	},

	correctEntry: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const entryId = formText(form, 'entry_id');
		const isCurrent = formText(form, 'is_current') === 'on';
		const correction = {
			positionTitle: nullable(formText(form, 'position_title')),
			roleKey: nullable(formText(form, 'role_key')),
			organizationName: nullable(formText(form, 'organization_name')),
			periodFrom: nullable(formText(form, 'period_from')),
			periodTo: nullable(formText(form, 'period_to')),
			isCurrent
		};
		try {
			await correctExperienceEntry(resumeDeps(), subject, idOf(form, 'entry_id'), correction, meta);
		} catch (cause) {
			const problem = correctionProblem(cause);
			if (problem) return fail(400, { problem, target: `entry:${entryId}`, correcting: true });
			return targetFailure(cause, `entry:${entryId}`);
		}
		return { reviewed: `entry:${entryId}` };
	}
};
