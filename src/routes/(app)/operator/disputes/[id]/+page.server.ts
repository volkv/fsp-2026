import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import type { OverrideAxes } from '$lib/server/categorization/disputes';
import { invalid } from '$lib/server/companies/context';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { labelsOf } from '$lib/server/employer/vocabulary';
import { answerDispute, disputeCase, takeDispute } from '$lib/server/operator/disputes';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const now = new Date();
	try {
		const dispute = await disputeCase(db(), subject, meta, event.params.id, now);
		return {
			now,
			dispute,
			labels: labelsOf(dispute.vocabulary),
			grades: dispute.vocabulary.grades,
			roles: dispute.vocabulary.roles,
			skills: dispute.vocabulary.skills,
			answered: event.url.searchParams.get('answered')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

/** Axes of a manual decision from the form: an empty field leaves the axis «insufficient data». */
function axesOf(form: FormData): OverrideAxes {
	const roleKey = formText(form, 'roleKey');
	const gradeMin = formText(form, 'gradeMin');
	const gradeMax = formText(form, 'gradeMax');
	const confidence = formText(form, 'gradeConfidence').trim();
	const skills = form
		.getAll('stackSkillKeys')
		.filter((value): value is string => typeof value === 'string' && value !== '');
	if ((gradeMin === '') !== (gradeMax === '')) {
		throw invalid([{ path: 'axes.grade', code: 'range', message: 'Укажите обе границы грейда или ни одной' }]);
	}
	const value = Number(confidence.replace(',', '.'));
	if (gradeMin !== '' && (confidence === '' || Number.isNaN(value))) {
		throw invalid([{ path: 'axes.grade.confidence', code: 'required', message: 'Укажите уверенность от 0 до 1' }]);
	}
	return {
		roleKey: roleKey === '' ? null : roleKey,
		grade: gradeMin === '' ? null : { min: gradeMin, max: gradeMax, confidence: value },
		stackSkillKeys: [...new Set(skills)]
	};
}

export const actions: Actions = {
	take: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			await takeDispute(db(), subject, meta, event.params.id);
		} catch (cause) {
			return formFailure(cause);
		}
		return { taken: true };
	},
	uphold: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		try {
			await answerDispute(db(), subject, meta, event.params.id, {
				kind: 'uphold',
				resolution: formText(form, 'resolution')
			});
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?answered=upheld`);
	},
	change: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		try {
			await answerDispute(db(), subject, meta, event.params.id, {
				kind: 'change',
				resolution: formText(form, 'resolution'),
				axes: axesOf(form)
			});
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?answered=changed`);
	}
};
