import { formText } from '$lib/server/http/form';
import { db } from '$lib/server/db';
import { createdInSession } from '$lib/server/demo/newcomer';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { formFailure, pageError } from '$lib/server/http/page';
import { openSpecializations } from '$lib/server/assessments/bank-store';
import { configuredNeedDeps } from '$lib/server/needs/page';
import { recommendCategories } from '$lib/server/needs/recommend';
import { getNeed } from '$lib/server/needs/service';
import { evaluationSummary } from '$lib/server/shortlists/evaluation';
import {
	blockTitles,
	categoriesFromPost,
	configuredShortlistDeps,
	refinementFromPost,
	whatIfFromQuery
} from '$lib/server/shortlists/page';
import { markCandidate, openShortlist, reviseShortlist, unmarkCandidate, whatIf } from '$lib/server/shortlists/service';
import type { Actions, PageServerLoad } from './$types';

/**
 * A shortlist (domain 13.10): the step asked for — the latest by default — ranked now through `canShow`, with the
 * reasons of each candidate, the marked ones and their state, the history of steps, the range of the need against the
 * cohorts, «what if» of the address and the results of «Оцените подбор». Candidate ids never leave the server.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	const deps = configuredShortlistDeps();
	const revisionParam = event.url.searchParams.get('revision');
	try {
		const view = await openShortlist(deps, subject, event.params.id, {
			...(revisionParam === null ? {} : { revision: Number(revisionParam) }),
			...(event.url.searchParams.get('cursor') ? { cursor: event.url.searchParams.get('cursor') ?? '' } : {}),
			signal: event.request.signal
		});
		const change = await whatIfFromQuery(event.url);
		const answer = change === null ? null : await whatIf(deps, subject, event.params.id, change, event.request.signal);
		const need = await getNeed(configuredNeedDeps(), subject, view.needId);
		const ownCandidates = await createdInSession(
			db(),
			view.items.map((item) => item.candidateId)
		);
		const labels = labelsOf(await currentVocabulary(db()));
		const form = view.revision.query.form;
		const offered = recommendCategories(
			{ ...form, specialization: form.specialization ?? need.form.specialization },
			await openSpecializations(db())
		);
		const categories = [
			...view.revision.query.categories,
			...offered.filter(
				(c) =>
					!view.revision.query.categories.some(
						(own) => own.specialization === c.specialization && own.grade === c.grade
					)
			)
		].map(({ specialization, grade }) => ({ specialization, grade }));
		return {
			shortlist: {
				id: view.id,
				needId: view.needId,
				needText: view.needText,
				status: view.status,
				revision: view.revision,
				latestSeq: view.latestSeq,
				history: view.history,
				total: view.total,
				nextCursor: view.nextCursor,
				salary: view.salary,
				exposure: view.exposure,
				mode: view.mode,
				coverage: view.coverage,
				groups: view.groups,
				items: view.items.map((item) => ({
					pseudonym: item.pseudonym,
					match: item.needMatch,
					offerFit: item.offerFit,
					mark: item.mark,
					hasFsp: item.hasFsp,
					createdInSession: ownCandidates.has(item.candidateId)
				})),
				marked: view.marked.map((mark) => ({
					pseudonym: mark.pseudonym,
					state: mark.state,
					position: mark.position,
					note: mark.note,
					markedAt: mark.markedAt
				}))
			},
			whatIf: answer && {
				change: answer.change,
				before: answer.before,
				after: answer.after,
				entered: answer.entered.map(({ pseudonym, reason, position }) => ({ pseudonym, reason, position })),
				left: answer.left.map(({ pseudonym, reason, position }) => ({ pseudonym, reason, position })),
				salary: answer.salary
			},
			categories,
			evaluations: await evaluationSummary(deps, subject, event.params.id),
			names: {
				skills: labels.skills,
				specializations: labels.specializations,
				roles: labels.roles,
				grades: labels.grades,
				workFormats: labels.terms.work_format,
				blocks: blockTitles()
			}
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	revise: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		try {
			const revised = await reviseShortlist(
				configuredShortlistDeps(),
				subject,
				meta,
				event.params.id,
				await refinementFromPost(form)
			);
			return { revised: revised.revision };
		} catch (cause) {
			return formFailure(cause);
		}
	},

	/** A deliberate widening by a neighbouring grade the shortlist offers: the step's categories and that one. */
	widen: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		try {
			const revised = await reviseShortlist(configuredShortlistDeps(), subject, meta, event.params.id, {
				categories: categoriesFromPost(form)
			});
			return { revised: revised.revision };
		} catch (cause) {
			return formFailure(cause);
		}
	},

	mark: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		try {
			await markCandidate(
				configuredShortlistDeps(),
				subject,
				meta,
				event.params.id,
				formText(form, 'pseudonym'),
				formText(form, 'note')
			);
			return { marked: true };
		} catch (cause) {
			return formFailure(cause);
		}
	},

	unmark: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		try {
			await unmarkCandidate(configuredShortlistDeps(), subject, meta, event.params.id, formText(form, 'pseudonym'));
			return { unmarked: true };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
