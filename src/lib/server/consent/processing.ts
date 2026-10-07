// The ground of processing a candidate's data (docs/domain.md, section 6): `pd_processing` in effect by
// `effectiveConsent` — for ages 14–17 signed by the subject and by a representative whose authority is verified. A
// resume, the answers of a platform test and the profile vectors are processed only on this ground; the check runs
// when the data is taken and again when a background result is written, since the consent may lapse in between.
import { and, eq, ne } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { candidates, representations } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { effectiveConsentsOf } from './effective';

/** Whether the candidate's data may be processed at `at`. */
export async function processingAllowed(executor: Executor, candidateId: string, at: Date): Promise<boolean> {
	return (await processingAllowedFor(executor, [candidateId], at)).has(candidateId);
}

/** The candidates among `candidateIds` whose data may be processed at `at`. */
export async function processingAllowedFor(
	executor: Executor,
	candidateIds: readonly string[],
	at: Date
): Promise<Set<string>> {
	return new Set((await effectiveConsentsOf(executor, candidateIds, 'pd_processing', at)).keys());
}

/** Why the candidate's data may not be processed, in the words the candidate is told. */
export interface ProcessingRefusal {
	code: 'representative_consent_required' | 'processing_consent_required';
	message: string;
}

/** What a step of a candidate aged 14–17 waits for from the legal representative. */
export type RepresentativeStep = 'processing' | 'disclosure';

/** Where the representation of a minor stands, as the refusal explains it. */
type RepresentativeState = 'none' | 'unverified' | 'verified';

const REPRESENTATIVE_STATES: Record<RepresentativeState, string> = {
	none: 'укажите законного представителя в профиле — оператор ФСП проверит его полномочия, и представитель подпишет согласие по ссылке из письма',
	unverified:
		'оператор ФСП ещё не проверил полномочия вашего законного представителя; после проверки представитель получит письмо со ссылкой на согласие',
	verified:
		'письмо со ссылкой на согласие отправлено вашему законному представителю; отправить его ещё раз можно на странице «Согласия»'
};

const REPRESENTATIVE_STEPS: Record<RepresentativeStep, string> = {
	processing:
		'Нужно согласие представителя: до 18 лет данные обрабатываются, когда согласие на обработку персональных данных подписал и законный представитель',
	disclosure:
		'Нужно согласие представителя: до 18 лет контакты раскрываются компании, только когда согласие на раскрытие по этому приглашению дал и законный представитель'
};

async function representativeState(executor: Executor, candidateId: string): Promise<RepresentativeState> {
	const rows = await executor
		.select({ status: representations.status })
		.from(representations)
		.where(and(eq(representations.candidateId, candidateId), ne(representations.status, 'ended')));
	if (rows.some((row) => row.status === 'authority_verified')) return 'verified';
	return rows.length > 0 ? 'unverified' : 'none';
}

/**
 * The refusal a candidate aged 14–17 reads where a step waits for the legal representative: the step, and what to do
 * next by where the representation stands. One code, `representative_consent_required`, on every path.
 */
export async function representativeRefusal(
	executor: Executor,
	candidateId: string,
	step: RepresentativeStep
): Promise<ProcessingRefusal> {
	const state = await representativeState(executor, candidateId);
	return {
		code: 'representative_consent_required',
		message: `${REPRESENTATIVE_STEPS[step]}: ${REPRESENTATIVE_STATES[state]}.`
	};
}

/** `null` — the candidate's data may be processed at `at`; otherwise why not. */
export async function processingRefusal(
	executor: Executor,
	candidateId: string,
	at: Date
): Promise<ProcessingRefusal | null> {
	if (await processingAllowed(executor, candidateId, at)) return null;
	const [candidate] = await executor
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate) throw new ApiError('not_found');
	if (isMinorBand(ageBand(candidate, at))) return representativeRefusal(executor, candidateId, 'processing');
	return {
		code: 'processing_consent_required',
		message: 'Нужно действующее согласие на обработку персональных данных: подтвердите его на странице «Согласия»'
	};
}

/** Refuses the candidate's action that processes their data while `pd_processing` is not in effect. */
export async function requireProcessingConsent(executor: Executor, candidateId: string, at: Date): Promise<void> {
	const refusal = await processingRefusal(executor, candidateId, at);
	if (refusal) {
		throw new ApiError('policy_violation', { message: refusal.message, details: [{ ...refusal }] });
	}
}
