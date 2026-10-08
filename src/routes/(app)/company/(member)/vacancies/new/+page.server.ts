import { fail, redirect } from '@sveltejs/kit';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { formText } from '$lib/server/http/form';
import { minorTermsAcceptance } from '$lib/server/companies/profile';
import { db } from '$lib/server/db';
import { employerRequest, vacancyAuthor } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { RATE_LIMIT_RULES } from '$lib/server/http/rate-limit';
import {
	EMPTY_VACANCY_FORM,
	readVacancyForm,
	vacancyFieldMessages,
	vacancyFormOfDraft,
	vacancyInput
} from '$lib/server/employer/vacancy-form';
import { currentVocabulary, formVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import type { CategoryKey } from '$lib/server/market/aggregate';
import { positionText, vacancyMarketPosition, type VacancyMarketPosition } from '$lib/server/market/read';
import { modelAdapter } from '$lib/server/ml';
import { redis } from '$lib/server/redis';
import type { SalaryTerms } from '$lib/server/salary/compare';
import {
	extractVacancyFromText,
	positionInput,
	unsavedVacancyOf,
	VACANCY_TEXT_MAX_LENGTH
} from '$lib/server/vacancies/from-text';
import { createOwnVacancy, type OwnVacancyInput } from '$lib/server/vacancies/own';
import { redisTextParseCache } from '$lib/server/vacancies/text-extract';
import { estimateVacancyPool, type UnsavedVacancy } from '$lib/server/vacancies/pool';
import { loadVacancyTaxonomy } from '$lib/server/vacancies/taxonomy';
import { draftTestSpecOf } from '$lib/server/vacancies/test-spec';
import type { Actions, PageServerLoad } from './$types';

function categoryLabel(key: CategoryKey): string {
	const specialization = CATALOG.specializations.find((s) => s.key === key.specialization)?.title ?? key.specialization;
	const grade = key.grade === undefined ? null : (CATALOG.grades.find((g) => g.key === key.grade)?.title ?? key.grade);
	return grade === null ? `${specialization} · все грейды` : `${specialization} · ${grade}`;
}

/** The position of the range for the page: the words of `positionText` and what each figure stands on. */
function marketPositionView(position: VacancyMarketPosition, taxBase: SalaryTerms['taxBase']) {
	if (position.status === 'no_specialization') return { state: 'no_specialization' as const, items: [] };
	return {
		state: 'evaluated' as const,
		items: position.positions.map((item) => ({
			indicator: item.indicator,
			status: item.status,
			comparison: item.status === 'compared' ? item.comparison : null,
			text: positionText(item, taxBase),
			category: item.status === 'insufficient_data' ? null : categoryLabel(item.categoryKey),
			basis:
				item.status === 'compared'
					? {
							sampleSize: item.figure.sampleSize,
							median: item.figure.median,
							p25: item.figure.p25,
							p75: item.figure.p75,
							currency: item.figure.currency,
							period: item.figure.period,
							taxBase: item.figure.taxBase,
							windowFrom: item.figure.window.from,
							windowTo: item.figure.window.to,
							estimated: item.figure.estimated,
							provenance: item.figure.provenance
						}
					: null
		}))
	};
}

/** The form as the employer filled it in, as the pool estimate reads it. */
function unsavedVacancyOfInput(input: OwnVacancyInput, taxonomyVersionId: string): UnsavedVacancy {
	return {
		title: input.title,
		description: input.description,
		roleKey: input.roleKey === '' ? null : input.roleKey,
		gradeMin: input.gradeMin === '' ? null : input.gradeMin,
		gradeMax: input.gradeMax === '' ? null : input.gradeMax,
		requiredSkillKeys: input.requiredSkillKeys,
		niceSkillKeys: input.niceSkillKeys,
		workFormat: input.workFormat === '' ? null : input.workFormat,
		salary: input.salary,
		taxonomyVersionId
	};
}

/** «In the pool ≈N» of an unsaved vacancy of the company: the same count as after saving, nothing is written. */
const poolEstimate = (companyId: string, unsaved: UnsavedVacancy, signal: AbortSignal) =>
	estimateVacancyPool(db(), modelAdapter(), companyId, unsaved, { now: new Date(), signal });

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const database = db();
	const vocabulary = await currentVocabulary(database);
	let companyId: string;
	try {
		companyId = vacancyAuthor(subject, meta).companyId;
	} catch (cause) {
		pageError(event, cause);
	}
	return {
		vocabulary: formVocabulary(vocabulary),
		empty: EMPTY_VACANCY_FORM,
		textMaxLength: VACANCY_TEXT_MAX_LENGTH,
		minorTermsAccepted: (await minorTermsAcceptance(database, companyId, new Date())) !== null
	};
};

export const actions: Actions = {
	/** The pasted text becomes a draft to check: fields with quotes, suggested by the model or read by the rules. */
	parse: async (event) => {
		// Over the limit of parses the hook lets the post through, for the form to say so in its own words.
		if (event.locals.rateLimited) {
			const text = formText(await event.request.formData(), 'text');
			const failure = formFailure(new ApiError('rate_limited', { message: RATE_LIMIT_RULES.textParse.message }));
			return fail(failure.status, { ...failure.data, text });
		}
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const text = formText(form, 'text');
		try {
			const author = vacancyAuthor(subject, meta);
			const draft = await extractVacancyFromText(
				{ db: db(), models: modelAdapter(), parseCache: redisTextParseCache(redis) },
				{ companyId: author.companyId },
				text,
				event.request.signal
			);
			const vocabulary = await currentVocabulary(db());
			const labels = labelsOf(vocabulary);
			const prefilled = vacancyFormOfDraft(draft, text.trim(), labels);
			const pool = await poolEstimate(author.companyId, unsavedVacancyOf(draft), event.request.signal);
			const testSpec = await draftTestSpecOf(
				db(),
				draft.fields,
				text.trim(),
				vocabulary,
				await loadVacancyTaxonomy(db())
			);
			return {
				draft: {
					mlResultId: draft.mlResultId,
					mode: draft.mode,
					modelFailure: draft.modelFailure,
					missing: draft.missing,
					textCheck: draft.textCheck,
					testSpec,
					skillNames: labels.skills,
					...prefilled
				},
				marketPosition: marketPositionView(draft.marketPosition, positionInput(draft.fields).salary.taxBase),
				pool,
				text
			};
		} catch (cause) {
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, text });
		}
	},

	/** The range of the form as the employer edited it, against the market of its category; nothing is saved. */
	position: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const values = readVacancyForm(form);
		const mlResultId = formText(form, 'mlResultId');
		const database = db();
		try {
			const author = vacancyAuthor(subject, meta);
			const taxonomy = await loadVacancyTaxonomy(database);
			const labels = labelsOf(await currentVocabulary(database));
			const parsed = vacancyInput(values, taxonomy, labels);
			if (!parsed.ok) return fail(400, { values, problems: parsed.fields, mlResultId });
			const { input } = parsed;
			const position = await vacancyMarketPosition(
				database,
				{
					roleKey: input.roleKey === '' ? null : input.roleKey,
					gradeMin: input.gradeMin === '' ? null : input.gradeMin,
					gradeMax: input.gradeMax === '' ? null : input.gradeMax,
					salary: input.salary
				},
				new Date()
			);
			const pool = await poolEstimate(
				author.companyId,
				unsavedVacancyOfInput(input, taxonomy.id),
				event.request.signal
			);
			return {
				values,
				mlResultId,
				marketPosition: marketPositionView(position, input.salary.taxBase),
				pool
			};
		} catch (cause) {
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, values, mlResultId });
		}
	},

	create: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const values = readVacancyForm(form);
		const mlResultId = formText(form, 'mlResultId');
		const database = db();
		let vacancyId: string;
		try {
			const author = vacancyAuthor(subject, meta);
			const taxonomy = await loadVacancyTaxonomy(database);
			const labels = labelsOf(await currentVocabulary(database));
			const parsed = vacancyInput(values, taxonomy, labels);
			if (!parsed.ok) return fail(400, { values, problems: parsed.fields, mlResultId });
			const created = await createOwnVacancy(
				{ db: database, now: () => new Date() },
				author,
				parsed.input,
				mlResultId === '' ? {} : { fromText: { mlResultId } }
			);
			vacancyId = created.id;
		} catch (cause) {
			if (cause instanceof ApiError && cause.code === 'validation_failed') {
				const failure = formFailure(cause);
				return fail(400, { values, problems: vacancyFieldMessages(failure.data.problem.fields), mlResultId });
			}
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, values, mlResultId });
		}
		redirect(303, `/company/vacancies/${vacancyId}?created=1`);
	}
};
