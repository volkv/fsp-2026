import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { CATEGORY_OPTIONS } from '$lib/server/categories/labels';
import { OBJECTION_DECISIONS, type RescoredItem } from '$lib/server/categories/objections';
import { invalid } from '$lib/server/companies/context';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { answerObjection, objectionCase, takeObjection } from '$lib/server/operator/objections';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const now = new Date();
	try {
		return {
			now,
			objection: await objectionCase(db(), OBJECTION_DECISIONS, subject, meta, event.params.id, now),
			options: CATEGORY_OPTIONS,
			answered: event.url.searchParams.get('answered')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

/** Corrected scores of clusters from the form: the rows filled in, each with its grounds. */
function rescoredItems(form: FormData): RescoredItem[] {
	const seqs = form.getAll('seq');
	const text = (value: FormDataEntryValue | undefined) => (typeof value === 'string' ? value : '');
	const scores = form.getAll('score');
	const reasons = form.getAll('itemReason');
	const items: RescoredItem[] = [];
	seqs.forEach((raw, index) => {
		const seq = text(raw).trim();
		if (seq === '') return;
		const score = text(scores[index]).replace(',', '.').trim();
		if (!/^\d+$/.test(seq) || score === '' || Number.isNaN(Number(score))) {
			throw invalid([
				{ path: `rescored_items.${index}`, code: 'invalid', message: 'Номер слота — целое, балл — число от 0 до 1' }
			]);
		}
		items.push({ seq: Number(seq), score: Number(score), reason: text(reasons[index]) });
	});
	return items;
}

export const actions: Actions = {
	take: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			await takeObjection(db(), subject, meta, event.params.id);
		} catch (cause) {
			return formFailure(cause);
		}
		return { taken: true };
	},
	answer: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		const outcome = formText(form, 'outcome');
		const resolution = formText(form, 'resolution');
		try {
			if (outcome !== 'upheld' && outcome !== 'annulled' && outcome !== 'rescored') {
				throw invalid([{ path: 'outcome', code: 'required', message: 'Выберите исход' }]);
			}
			await answerObjection(
				db(),
				OBJECTION_DECISIONS,
				subject,
				meta,
				event.params.id,
				outcome === 'rescored' ? { outcome, resolution, items: rescoredItems(form) } : { outcome, resolution }
			);
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?answered=${outcome}`);
	}
};
