// Shared vocabulary of the external profiles (docs/domain.md, section 9.4).
import type { EXTERNAL_PLATFORMS, EXTERNAL_SYNC_STATUSES } from '$lib/server/db/schema';

export type ExternalPlatform = (typeof EXTERNAL_PLATFORMS)[number];
export type SyncStatus = (typeof EXTERNAL_SYNC_STATUSES)[number];

export const PLATFORM_NAMES: Record<ExternalPlatform, string> = { codeforces: 'Codeforces', github: 'GitHub' };

/** How long a one-time code waits to be found in the profile. */
export const CHALLENGE_TTL_MS = 60 * 60 * 1000;
/** Checks of one code; then a new code is needed. */
export const MAX_CHALLENGE_ATTEMPTS = 10;
/** A candidate asks for a new reading of a verified profile at most this often. */
export const MANUAL_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/** The schedule reads every verified profile once in this period. */
export const REFRESH_PERIOD_MS = 24 * 60 * 60 * 1000;
