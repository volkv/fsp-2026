// What the test engine needs from the owner of categories (docs/domain.md, 12.4, 23.1): `applyGradeDecisions` in the
// transaction of every change of the decisions (a new one, an annulment, a review) — the owner brings the category, the
// fact of the test (10.9), the attestations and the profile revision to `resolveCategory` over all decisions of the
// specialization. The engine never writes `candidate_categories` or the fact of the test itself. Who may start which
// test is answered by the owner of the grade policy (`grades/policy.ts`, `admitGradeTest`).
import type { AuditActor } from '$lib/server/audit/record';
import { GRADE_DECISIONS } from '$lib/server/categories/decisions';
import { applyGradeDecisions } from '$lib/server/categories/publish';
import type { Transaction } from '$lib/server/db';
import type { SpecializationKey } from './contract/catalog';
import type { CategoryChange } from './contract/policy';

export interface GradeStanding {
	/**
	 * The decisions of the specialization changed: the owner of the category brings everything to `resolveCategory` and
	 * names the change (`categoryChange` of the contract).
	 */
	applyGradeDecisions(
		tx: Transaction,
		candidateId: string,
		specialization: SpecializationKey,
		journal: { requestId: string; actor: AuditActor }
	): Promise<CategoryChange>;
}

export const OWNER_STANDING: GradeStanding = {
	applyGradeDecisions: async (tx, candidateId, specialization, journal) =>
		(await applyGradeDecisions(tx, candidateId, specialization, journal, GRADE_DECISIONS)).change
};
