import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import { formFailure, pageError } from '$lib/server/http/page';
import { loadCandidateSnapshots } from '$lib/server/matching/evidence';
import { judgeEvaluation, openEvaluation, startEvaluation } from '$lib/server/shortlists/evaluation';
import { configuredShortlistDeps } from '$lib/server/shortlists/page';
import { shortlistStep } from '$lib/server/shortlists/service';
import type { Actions, PageServerLoad } from './$types';

/**
 * «Оцените подбор» (contracts 11.2, item 10): the cards of the shortlist's top ten and of a keyword search — on the
 * confirmed pool, or over the whole catalog as an experiment — mixed and shuffled,
 * shown as the catalog shows a candidate — categories and skills with their basis — without score, position or system.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	const deps = configuredShortlistDeps();
	const evaluationId = event.url.searchParams.get('e');
	try {
		const { shortlist, step, needText } = await shortlistStep(deps, subject, event.params.id);
		const labels = labelsOf(await currentVocabulary(db()));
		const base = {
			shortlistId: shortlist.id,
			needText,
			form: step.query.form,
			names: { skills: labels.skills, specializations: labels.specializations, grades: labels.grades }
		};
		if (evaluationId === null) return { ...base, evaluation: null };
		const opened = await openEvaluation(deps, subject, shortlist.id, evaluationId);
		const ids = opened.cards.flatMap((card) => (card.candidateId === null ? [] : [card.candidateId]));
		const snapshots = await loadCandidateSnapshots(db(), ids);
		return {
			...base,
			evaluation: {
				id: evaluationId,
				scope: opened.scope,
				judged: opened.judged,
				cards: opened.cards.map((card) => {
					const snapshot = card.candidateId === null ? undefined : snapshots.get(card.candidateId);
					return {
						position: card.position,
						available: snapshot !== undefined,
						categories: snapshot?.confirmed.map(({ specialization, grade }) => ({ specialization, grade })) ?? [],
						confirmedSkills: snapshot?.confirmed.flatMap((c) => c.confirmedSkillKeys) ?? [],
						skills:
							snapshot?.evidence.status === 'available'
								? snapshot.evidence.skills.map((skill) => ({
										key: skill.skillKey,
										confirmed:
											skill.attestation === 'direct' &&
											(skill.badgeTrust === 'fsp_verified' || skill.badgeTrust === 'platform_verified')
									}))
								: []
					};
				})
			}
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	start: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		let id: string;
		try {
			const scope = formText(await event.request.formData(), 'scope');
			if (scope !== 'confirmed_pool' && scope !== 'whole_catalog') {
				throw new ApiError('validation_failed', {
					details: [{ path: 'scope', code: 'invalid', message: 'Выберите часть сравнения' }]
				});
			}
			id = (
				await startEvaluation(configuredShortlistDeps(), subject, meta, event.params.id, scope, event.request.signal)
			).id;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/shortlists/${event.params.id}/evaluate?e=${id}`);
	},

	judge: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		const evaluationId = formText(form, 'evaluation');
		const selected = form
			.getAll('selected')
			.map((value) => Number(value))
			.filter((value) => Number.isInteger(value));
		try {
			return {
				result: await judgeEvaluation(configuredShortlistDeps(), subject, meta, event.params.id, evaluationId, selected)
			};
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
