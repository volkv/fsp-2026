// `effectiveConsent(candidate, fsp_import, at)` (docs/domain.md, section 6.3): the grounds of every achievements
// import, checked when a sync job runs and again when it writes (contracts 1.2), and by the webhook before enqueueing.
import { effectiveConsentOf } from '$lib/server/consent/effective';
import type { Executor } from '$lib/server/db';

/** The id of the subject's `fsp_import` grant in effect at `at`, or `null` when there is none. */
export function effectiveFspImportConsent(executor: Executor, candidateId: string, at: Date): Promise<string | null> {
	return effectiveConsentOf(executor, candidateId, 'fsp_import', at);
}
