import { recordAuditEvent } from '$lib/server/audit/record';
import type { Executor } from '$lib/server/db';

/** The end of a demo seed of `batch`, as the seed journals it last: demo sessions clone only a finished seed. */
export function recordSeeded(executor: Executor, batch: string): Promise<void> {
	return recordAuditEvent(executor, {
		action: 'demo.seeded',
		outcome: 'success',
		actor: { kind: 'system' },
		requestId: 'test',
		details: {
			batch,
			candidates: 0,
			vacancies: 0,
			tests_open: [],
			tests_closed: {},
			tests_untested: 0,
			tests_closed_needs: 0,
			tests_closed_scenes: []
		}
	});
}
