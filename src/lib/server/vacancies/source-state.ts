// A source that refuses us by rights or terms is switched off until an administrator decides (contracts 7.2); the
// journal tells the administrator which source, why and which run or check met the refusal.
import { eq } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Executor } from '$lib/server/db';
import { vacancySources } from '$lib/server/db/schema';

export interface SourceRefusal {
	source: string;
	/** Where the refusal came: an import run or a freshness check of a posting. */
	via: { kind: 'import'; runId: string } | { kind: 'freshness_check'; postingId: string };
	requestId: string;
}

export async function disableRefusedSource(executor: Executor, refusal: SourceRefusal): Promise<void> {
	await executor.update(vacancySources).set({ enabled: false }).where(eq(vacancySources.key, refusal.source));
	await recordAuditEvent(executor, {
		action: 'vacancy_source.disabled',
		outcome: 'success',
		actor: { kind: 'system' },
		object: { type: 'vacancy_source', id: refusal.source },
		requestId: refusal.requestId,
		details: {
			source: refusal.source,
			reason: 'source_forbidden',
			via: refusal.via.kind,
			...(refusal.via.kind === 'import' ? { run_id: refusal.via.runId } : { posting_id: refusal.via.postingId })
		}
	});
}
