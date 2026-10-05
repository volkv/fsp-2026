// Dependencies of the matching entry points: the database, the model adapter, pseudonyms and the clock. Routes take
// the configured ones; tests pass their own.
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db, type Executor } from '$lib/server/db';
import { modelAdapter } from '$lib/server/ml';
import type { MatchingModels } from './semantic';
import { GRADE_DECISION_RESULTS, type TestResultReader } from './test-results';

export interface MatchingDeps {
	db: Executor;
	models: MatchingModels;
	/** Pseudonym of a candidate for a company (domain 14). */
	pseudonym: (candidateId: string, companyId: string) => string;
	now: () => Date;
	/** Results of the test by blocks for the strength of a confirmed profile (domain 13.10). */
	testResults: TestResultReader;
}

export function matchingDeps(): MatchingDeps {
	const crypto = fieldCrypto();
	return {
		db: db(),
		models: modelAdapter(),
		pseudonym: (candidateId, companyId) => crypto.pseudonym(candidateId, companyId),
		now: () => new Date(),
		testResults: GRADE_DECISION_RESULTS
	};
}
