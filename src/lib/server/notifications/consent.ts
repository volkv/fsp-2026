// `effectiveConsent(candidate, telegram_notifications, at)` (docs/domain.md, sections 3.7, 6.3): the ground of the
// Telegram channel, checked when the chat is linked and again before every message.
import { eq } from 'drizzle-orm';
import { effectiveConsentOf } from '$lib/server/consent/effective';
import type { Executor } from '$lib/server/db';
import { candidates } from '$lib/server/db/schema';

/**
 * The id of the `telegram_notifications` grant of the user's candidate in effect at `at`, or `null`: the consent is
 * the candidate's, so a user without a candidate profile has none.
 */
export async function effectiveTelegramConsent(executor: Executor, userId: string, at: Date): Promise<string | null> {
	const [candidate] = await executor
		.select({ id: candidates.id })
		.from(candidates)
		.where(eq(candidates.userId, userId));
	return candidate ? effectiveConsentOf(executor, candidate.id, 'telegram_notifications', at) : null;
}
