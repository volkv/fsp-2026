import { fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { formText } from '$lib/server/auth/http';
import { minorTermsAcceptance } from '$lib/server/companies/profile';
import { db, type Executor } from '$lib/server/db';
import { vacancies } from '$lib/server/db/schema';
import { employerRequest, vacancyAuthor } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import {
	EMPTY_VACANCY_FORM,
	readVacancyForm,
	vacancyFieldMessages,
	vacancyFormOfDraft,
	vacancyInput
} from '$lib/server/employer/vacancy-form';
import type { VacancyFormValues } from '$lib/components/employer/model';
import { currentVocabulary, formVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import type { CategoryKey } from '$lib/server/market/aggregate';
import { positionText, vacancyMarketPosition, type VacancyMarketPosition } from '$lib/server/market/read';
import { modelAdapter } from '$lib/server/ml';
import type { SalaryTerms } from '$lib/server/salary/compare';
import {
	extractVacancyFromText,
	positionInput,
	unsavedVacancyOf,
	VACANCY_TEXT_MAX_LENGTH
} from '$lib/server/vacancies/from-text';
import { holdsApprovedClaim } from '$lib/server/vacancies/claims';
import { invalid } from '$lib/server/vacancies/errors';
import { createOwnVacancy, type OwnVacancyInput } from '$lib/server/vacancies/own';
import { estimateVacancyPool, type UnsavedVacancy } from '$lib/server/vacancies/pool';
import { loadVacancyTaxonomy } from '$lib/server/vacancies/taxonomy';
import type { Actions, PageServerLoad } from './$types';

type Labels = ReturnType<typeof labelsOf>;

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

const DERIVED_FIELD = 'derivedFromVacancyId';

/**
 * The external vacancy a new one is created from (`?from=`): the company holds it after an approved «this is our
 * vacancy» claim. The form is prefilled with what the postings state; the service checks the claim again on save.
 */
async function derivedSource(executor: Executor, externalId: string, companyId: string, labels: Labels) {
	if (!z.uuid().safeParse(externalId).success) throw new ApiError('not_found');
	if (!(await holdsApprovedClaim(executor, externalId, companyId))) throw new ApiError('not_found');
	const [row] = await executor
		.select()
		.from(vacancies)
		.where(and(eq(vacancies.id, externalId), eq(vacancies.origin, 'external')));
	if (!row) throw new ApiError('not_found');
	const skillNames = (keys: readonly string[]) => keys.map((key) => labels.skills[key] ?? key).join(', ');
	const values: VacancyFormValues = {
		...EMPTY_VACANCY_FORM,
		title: row.title,
		description: row.description ?? '',
		roleKey: row.roleKey ?? '',
		gradeMin: row.gradeMin ?? '',
		gradeMax: row.gradeMax ?? '',
		requiredSkills: skillNames(row.requiredSkillKeys),
		niceSkills: skillNames(row.niceSkillKeys),
		workFormat: row.workFormat ?? '',
		employmentForm: row.employmentForm ?? '',
		contractTypes: row.contractTypes ?? [],
		cityId: row.cityId ?? '',
		salaryMin: row.salaryMin === null ? '' : String(row.salaryMin),
		salaryMax: row.salaryMax === null ? '' : String(row.salaryMax),
		currency: row.salaryCurrency ?? '',
		period: row.salaryPeriod ?? '',
		taxBase: row.salaryTaxBase === 'gross' || row.salaryTaxBase === 'net' ? row.salaryTaxBase : ''
	};
	return { id: row.id, title: row.title, values };
}

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const from = event.url.searchParams.get('from');
	const database = db();
	const vocabulary = await currentVocabulary(database);
	let companyId: string;
	let derived: Awaited<ReturnType<typeof derivedSource>> | null = null;
	try {
		companyId = vacancyAuthor(subject, meta).companyId;
		if (from !== null) derived = await derivedSource(database, from, companyId, labelsOf(vocabulary));
	} catch (cause) {
		pageError(event, cause);
	}
	return {
		vocabulary: formVocabulary(vocabulary),
		empty: EMPTY_VACANCY_FORM,
		derived,
		textMaxLength: VACANCY_TEXT_MAX_LENGTH,
		minorTermsAccepted: (await minorTermsAcceptance(database, companyId, new Date())) !== null
	};
};

export const actions: Actions = {
	/** The pasted text becomes a draft to check: fields with quotes, suggested by the model or read by the rules. */
	parse: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const text = formText(form, 'text');
		const derivedFromVacancyId = formText(form, DERIVED_FIELD);
		try {
			const author = vacancyAuthor(subject, meta);
			const draft = await extractVacancyFromText(
				{ db: db(), models: modelAdapter() },
				{ companyId: author.companyId },
				text,
				event.request.signal
			);
			const labels = labelsOf(await currentVocabulary(db()));
			const prefilled = vacancyFormOfDraft(draft, text.trim(), labels);
			const pool = await poolEstimate(author.companyId, unsavedVacancyOf(draft), event.request.signal);
			return {
				draft: {
					mlResultId: draft.mlResultId,
					mode: draft.mode,
					modelFailure: draft.modelFailure,
					missing: draft.missing,
					textCheck: draft.textCheck,
					...prefilled
				},
				marketPosition: marketPositionView(draft.marketPosition, positionInput(draft.fields).salary.taxBase),
				pool,
				text,
				derivedFromVacancyId
			};
		} catch (cause) {
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, text, derivedFromVacancyId });
		}
	},

	/** The range of the form as the employer edited it, against the market of its category; nothing is saved. */
	position: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const values = readVacancyForm(form);
		const mlResultId = formText(form, 'mlResultId');
		const derivedFromVacancyId = formText(form, DERIVED_FIELD);
		const database = db();
		try {
			const author = vacancyAuthor(subject, meta);
			const taxonomy = await loadVacancyTaxonomy(database);
			const labels = labelsOf(await currentVocabulary(database));
			const parsed = vacancyInput(values, taxonomy, labels);
			if (!parsed.ok) return fail(400, { values, problems: parsed.fields, mlResultId, derivedFromVacancyId });
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
				derivedFromVacancyId,
				marketPosition: marketPositionView(position, input.salary.taxBase),
				pool
			};
		} catch (cause) {
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, values, mlResultId, derivedFromVacancyId });
		}
	},

	create: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const values = readVacancyForm(form);
		const mlResultId = formText(form, 'mlResultId');
		const derivedFromVacancyId = formText(form, DERIVED_FIELD);
		const database = db();
		let vacancyId: string;
		try {
			const author = vacancyAuthor(subject, meta);
			const taxonomy = await loadVacancyTaxonomy(database);
			const labels = labelsOf(await currentVocabulary(database));
			const parsed = vacancyInput(values, taxonomy, labels);
			if (!parsed.ok) return fail(400, { values, problems: parsed.fields, mlResultId, derivedFromVacancyId });
			if (derivedFromVacancyId !== '' && !z.uuid().safeParse(derivedFromVacancyId).success) {
				throw invalid(DERIVED_FIELD, 'not a vacancy id');
			}
			const created = await createOwnVacancy({ db: database, now: () => new Date() }, author, parsed.input, {
				...(mlResultId === '' ? {} : { fromText: { mlResultId } }),
				...(derivedFromVacancyId === '' ? {} : { derivedFromVacancyId })
			});
			vacancyId = created.id;
		} catch (cause) {
			if (cause instanceof ApiError && cause.code === 'validation_failed') {
				const failure = formFailure(cause);
				const { [DERIVED_FIELD]: derivedProblem, ...fields } = failure.data.problem.fields;
				// The external vacancy is not a field of the form: its refusal is said above the form.
				if (derivedProblem !== undefined) {
					return fail(400, {
						values,
						mlResultId,
						derivedFromVacancyId,
						problem: {
							...failure.data.problem,
							message: 'Внешняя вакансия не подтверждена за вашей компанией — создать вакансию на её основе нельзя',
							fields
						}
					});
				}
				return fail(400, {
					values,
					problems: vacancyFieldMessages(failure.data.problem.fields),
					mlResultId,
					derivedFromVacancyId
				});
			}
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, values, mlResultId, derivedFromVacancyId });
		}
		redirect(303, `/company/vacancies/${vacancyId}?created=1`);
	}
};
