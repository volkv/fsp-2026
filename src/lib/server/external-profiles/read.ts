// The candidate's own view of the linked public profiles: the state of each, the pending code with its deadline, the
// date of the last reading and what the current fact of the profile says.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { externalProfiles, sourceFacts, verificationReceipts } from '$lib/server/db/schema';
import { receiptStatementSchema, receiptStatus, type ReceiptStatus } from '$lib/server/fsp/receipts';
import type { CodeforcesPayload, GithubPayload } from './facts';
import type { SourceFailure } from './http';
import { MAX_CHALLENGE_ATTEMPTS, type ExternalPlatform, type SyncStatus } from './types';

export type ProfileSummary =
	{ kind: 'codeforces'; data: CodeforcesPayload } | { kind: 'github'; data: GithubPayload } | null;

export interface OwnExternalProfile {
	id: string;
	platform: ExternalPlatform;
	handle: string;
	status: 'unverified' | 'verified';
	verifiedAt: Date | null;
	/** The code to put in the profile while it waits; `null` — none issued or it has expired. */
	challenge: { code: string; expiresAt: Date; attemptsLeft: number } | null;
	syncStatus: SyncStatus | null;
	syncError: SourceFailure | null;
	syncCheckedAt: Date | null;
	syncedAt: Date | null;
	/** The current fact of the profile. */
	factId: string | null;
	/** The candidate's own receipt of the current fact: what it confirms and what it does not. */
	receipt: {
		handle: string;
		status: ReceiptStatus;
		verifiedAt: string;
		asserts: Record<string, string | number>;
		doesNotAssert: string[];
		signingKeyId: string;
	} | null;
	summary: ProfileSummary;
}

const SOURCE_FAILURES: readonly string[] = ['timeout', 'network', 'rate_limited', 'server_error', 'protocol_error'];

function failureOf(value: string | null): SourceFailure | null {
	if (value === null) return null;
	if (!SOURCE_FAILURES.includes(value)) throw new Error(`unknown source failure ${value}`);
	return value as SourceFailure;
}

export async function readOwnExternalProfiles(
	executor: Executor,
	candidateId: string,
	now: Date
): Promise<OwnExternalProfile[]> {
	const profiles = await executor
		.select()
		.from(externalProfiles)
		.where(eq(externalProfiles.candidateId, candidateId))
		.orderBy(externalProfiles.platform);
	const facts = await executor
		.select({
			id: sourceFacts.id,
			source: sourceFacts.source,
			payload: sourceFacts.payload,
			status: sourceFacts.status,
			payloadSha256: sourceFacts.payloadSha256
		})
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, candidateId),
				inArray(sourceFacts.source, ['codeforces', 'github']),
				eq(sourceFacts.ownershipBasis, 'handle_challenge'),
				eq(sourceFacts.status, 'active')
			)
		);
	const receipts =
		facts.length === 0
			? []
			: await executor
					.select()
					.from(verificationReceipts)
					.where(
						and(
							inArray(
								verificationReceipts.factId,
								facts.map((f) => f.id)
							),
							isNull(verificationReceipts.audienceCompanyId),
							eq(verificationReceipts.disclosureLevel, 'generalized')
						)
					);
	return profiles.map((profile) => {
		const fact = profile.ownershipStatus === 'verified' ? facts.find((f) => f.source === profile.platform) : undefined;
		const receiptOf = (current: (typeof facts)[number] | undefined) => {
			const row =
				current && receipts.find((r) => r.factId === current.id && r.factPayloadSha256 === current.payloadSha256);
			if (!current || !row) return null;
			const statement = receiptStatementSchema.parse(row.statement);
			return {
				handle: row.handle,
				status: receiptStatus(current.status, true),
				verifiedAt: statement.verified_at,
				asserts: statement.asserts,
				doesNotAssert: statement.does_not_assert,
				signingKeyId: row.signingKeyId
			};
		};
		const code = profile.challengeCode;
		const expiresAt = profile.challengeExpiresAt;
		return {
			id: profile.id,
			platform: profile.platform,
			handle: profile.handle,
			status: profile.ownershipStatus,
			verifiedAt: profile.verifiedAt,
			challenge:
				code !== null && expiresAt !== null && expiresAt > now
					? {
							code,
							expiresAt,
							attemptsLeft: Math.max(0, MAX_CHALLENGE_ATTEMPTS - profile.challengeAttempts)
						}
					: null,
			syncStatus: profile.syncStatus,
			syncError: failureOf(profile.syncError),
			syncCheckedAt: profile.syncCheckedAt,
			syncedAt: profile.syncedAt,
			factId: fact?.id ?? null,
			receipt: receiptOf(fact),
			summary:
				fact === undefined
					? null
					: profile.platform === 'codeforces'
						? { kind: 'codeforces', data: fact.payload as CodeforcesPayload }
						: { kind: 'github', data: fact.payload as GithubPayload }
		};
	});
}
