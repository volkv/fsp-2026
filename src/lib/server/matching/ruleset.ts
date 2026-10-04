// Match rule sets (docs/domain.md, sections 11 and 13.4). The rule set ships as `taxonomy/match-ruleset.json` and is
// stored by the taxonomy publication; a stored rule set is immutable and a change of any parameter is a new version.
import { desc } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { matchRulesets } from '$lib/server/db/schema';
import { matchRulesetParamsSchema, type MatchRulesetParams } from './params';

export interface MatchRuleset {
	id: string;
	version: number;
	params: MatchRulesetParams;
}

export class MatchRulesetError extends Error {
	readonly code: 'ruleset_missing';

	constructor(code: MatchRulesetError['code'], message: string) {
		super(message);
		this.name = 'MatchRulesetError';
		this.code = code;
	}
}

/** The rule set in force: the highest stored version. */
export async function loadActiveMatchRuleset(executor: Executor): Promise<MatchRuleset> {
	const [row] = await executor.select().from(matchRulesets).orderBy(desc(matchRulesets.version)).limit(1);
	if (!row) throw new MatchRulesetError('ruleset_missing', 'no match rule set is stored');
	return { id: row.id, version: row.version, params: matchRulesetParamsSchema.parse(row.params) };
}
