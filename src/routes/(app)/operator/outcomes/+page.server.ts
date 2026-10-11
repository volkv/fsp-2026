import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { careerFunnel, FUNNEL_DIMENSIONS, type FunnelFilter } from '$lib/server/hiring/funnel';
import { interviewCalibration } from '$lib/server/hiring/interview-feedback';
import { invitationDeps } from '$lib/server/invitations/deps';
import { operatorRequest } from '$lib/server/operator/http';
import { smallCountThreshold } from '$lib/server/operator/small-numbers';
import type { PageServerLoad } from './$types';

/** The filters the page offers; the query parameters are named after the dimensions. */
const FILTERS = ['fsp_discipline', 'fsp_level', 'specialization', 'region'] as const satisfies readonly FunnelFilter[];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(value: string | null): string | null {
	return value !== null && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	const params = event.url.searchParams;
	const dimension = FUNNEL_DIMENSIONS.find((value) => value === params.get('by')) ?? 'fsp_discipline';
	const inner = FUNNEL_DIMENSIONS.find((value) => value === params.get('then') && value !== dimension) ?? null;
	const from = dateParam(params.get('from'));
	const to = dateParam(params.get('to'));
	const where: Partial<Record<(typeof FILTERS)[number], string>> = {};
	for (const filter of FILTERS) {
		const value = params.get(filter)?.trim();
		if (value) where[filter] = value;
	}
	try {
		const labels = labelsOf(await currentVocabulary(db()));
		return {
			filters: { dimension, inner, from, to, where },
			funnel: await careerFunnel(invitationDeps(), subject, {
				dimensions: inner === null ? [dimension] : [dimension, inner],
				where,
				...(from === null ? {} : { from: new Date(`${from}T00:00:00Z`) }),
				...(to === null ? {} : { to: new Date(`${to}T00:00:00Z`) })
			}),
			calibration: await interviewCalibration(db(), subject, await smallCountThreshold(db(), new Date())),
			specializations: labels.specializations,
			grades: labels.grades
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
