// `isInvitable(vacancy)` — the only check whether an offer may name a vacancy (docs/domain.md, section 13.1). The offer
// itself does not need a vacancy; when it names one, that is a published vacancy with a full range in roubles and a
// known tax base. Whether the company may act at all is the admission policy (domain 5.1), checked separately; that
// the vacancy belongs to the sender's company is checked by the sending.
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { vacancies } from '$lib/server/db/schema';

export interface InvitabilityFacts {
	status: string;
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryTaxBase: 'gross' | 'net' | 'unknown' | null;
}

export type InvitabilityDenial = 'not_published' | 'incomplete_salary';

export type Invitability = { invitable: true } | { invitable: false; reason: InvitabilityDenial };

/** A published vacancy with both salary bounds in roubles and a known tax base. */
export function isInvitable(vacancy: InvitabilityFacts): Invitability {
	if (vacancy.status !== 'published') return { invitable: false, reason: 'not_published' };
	if (
		vacancy.salaryMin === null ||
		vacancy.salaryMax === null ||
		vacancy.salaryCurrency !== 'RUB' ||
		vacancy.salaryTaxBase === null ||
		vacancy.salaryTaxBase === 'unknown'
	) {
		return { invitable: false, reason: 'incomplete_salary' };
	}
	return { invitable: true };
}

/** Reads the vacancy at this moment; `null` — no such vacancy. */
export async function loadInvitability(executor: Executor, vacancyId: string): Promise<Invitability | null> {
	const [row] = await executor
		.select({
			status: vacancies.status,
			salaryMin: vacancies.salaryMin,
			salaryMax: vacancies.salaryMax,
			salaryCurrency: vacancies.salaryCurrency,
			salaryTaxBase: vacancies.salaryTaxBase
		})
		.from(vacancies)
		.where(eq(vacancies.id, vacancyId));
	return row ? isInvitable(row) : null;
}
