// The partnership forms of the operator cabinet, shared by the partnerships page and the company card: the posted
// fields turned into the input of `companies/partnerships.ts`, whose validation answers for the values.
import { formText } from '$lib/server/http/form';
import { AWARDS } from '$lib/fsp/awards';
import type { ActionContext, CompanyDeps } from '$lib/server/companies/context';
import {
	endPartnership,
	openPartnership,
	type PartnershipKind,
	type PoolRule
} from '$lib/server/companies/partnerships';
import { invalid } from '$lib/server/companies/context';
import { ApiError } from '$lib/server/errors/api-error';
import { z } from 'zod';

const isId = (value: string) => z.uuid().safeParse(value).success;

const KINDS: readonly PartnershipKind[] = ['case_provider', 'sponsor', 'organizer_partner'];
const STAGES: readonly PoolRule['stages'][number][] = ['qualifier', 'final', 'single'];

export async function openPartnershipFromForm(deps: CompanyDeps, ctx: ActionContext, form: FormData): Promise<void> {
	const kind = KINDS.find((value) => value === formText(form, 'kind'));
	const minAward = AWARDS.find((value) => value === formText(form, 'minAward'));
	const posted = form.getAll('stages');
	const stages = STAGES.filter((stage) => posted.includes(stage));
	const companyId = formText(form, 'companyId');
	if (companyId !== '' && !isId(companyId)) throw new ApiError('not_found');
	if (kind === undefined || minAward === undefined || stages.length === 0 || companyId === '') {
		throw invalid([
			...(companyId === '' ? [{ path: 'companyId', code: 'required', message: 'Выберите компанию' }] : []),
			...(kind === undefined ? [{ path: 'kind', code: 'invalid', message: 'Выберите вид партнёрства' }] : []),
			...(minAward === undefined || stages.length === 0
				? [{ path: 'poolRule', code: 'invalid', message: 'Выберите награду и хотя бы один этап' }]
				: [])
		]);
	}
	const validTo = formText(form, 'validTo').trim();
	await openPartnership(deps, ctx, {
		companyId,
		competitionRef: formText(form, 'competitionRef'),
		kind,
		poolRule: { min_award: minAward, stages },
		validFrom: formText(form, 'validFrom').trim(),
		validTo: validTo === '' ? null : validTo,
		basis: formText(form, 'basis')
	});
}

export async function endPartnershipFromForm(deps: CompanyDeps, ctx: ActionContext, form: FormData): Promise<void> {
	const partnershipId = formText(form, 'partnershipId');
	if (!isId(partnershipId)) throw new ApiError('not_found');
	await endPartnership(deps, ctx, partnershipId);
}
