// A reading of a verified external profile as a source fact (docs/domain.md, sections 9.1, 9.4): one fact per profile,
// `trust_level = public_verifiable` because ownership was proven by a one-time code (`handle_challenge`). A changed
// reading supersedes the previous version, a profile gone from the source or unlinked withdraws it; any change moves
// the profile revision through the common path of evidence changes (`recordEvidenceChange`).
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { AuditActor } from '$lib/server/audit/record';
import type { Transaction } from '$lib/server/db';
import { sourceFacts } from '$lib/server/db/schema';
import {
	issueProfileSelfReceipt,
	loadReceiptTemplates,
	templateKey,
	type ProfileReceiptPayload,
	type ReceiptSigner
} from '$lib/server/fsp/receipts';
import type { JobCreator } from '$lib/server/jobs/queue';
import { canonicalJson } from '$lib/server/json/canonical';
import { recordEvidenceChange, retireFacts } from '$lib/server/resumes/revision';
import type { CodeforcesReading } from './codeforces';
import type { GithubReading } from './github';
import type { ExternalPlatform } from './types';

export type ProfileReading =
	{ platform: 'codeforces'; reading: CodeforcesReading } | { platform: 'github'; reading: GithubReading };

/** What a Codeforces fact keeps: the rating the way the FSP projection keeps a platform account, and the statistics. */
export interface CodeforcesPayload {
	account: { platform: 'codeforces'; login: string; rating: number | null };
	maxRating: number | null;
	rank: string | null;
	maxRank: string | null;
	solvedCount: number;
	ratedContests: number;
	lastRatedOn: string | null;
	registeredOn: string;
}

/**
 * What a GitHub fact keeps. The languages are those of the repositories, not a statement that every line is the
 * person's own: a repository may hold code of others.
 */
export interface GithubPayload {
	login: string;
	publicRepos: number;
	ownRepos: number;
	reposRead: number;
	languages: { name: string; share: number; repos: number }[];
	lastPushMonth: string | null;
	reposPushedLastYear: number;
	createdOn: string;
}

interface FactDraft {
	source: ExternalPlatform;
	factType: 'platform_rating' | 'repo_languages';
	sourceRecordRef: string;
	eventKey: string;
	payload: CodeforcesPayload | GithubPayload;
	payloadSha256: string;
	occurredOn: string | null;
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function readingFact(value: ProfileReading): FactDraft {
	if (value.platform === 'codeforces') {
		const r = value.reading;
		const payload: CodeforcesPayload = {
			account: { platform: 'codeforces', login: r.handle, rating: r.rating },
			maxRating: r.maxRating,
			rank: r.rank,
			maxRank: r.maxRank,
			solvedCount: r.solvedCount,
			ratedContests: r.ratedContests,
			lastRatedOn: r.lastRatedOn,
			registeredOn: r.registeredOn
		};
		const handle = r.handle.toLowerCase();
		return {
			source: 'codeforces',
			factType: 'platform_rating',
			sourceRecordRef: `codeforces:user:${handle}`,
			eventKey: `profile:codeforces:${handle}`,
			payload,
			payloadSha256: sha256Hex(canonicalJson(payload)),
			occurredOn: r.lastRatedOn
		};
	}
	const r = value.reading;
	const payload: GithubPayload = {
		login: r.login,
		publicRepos: r.publicRepos,
		ownRepos: r.ownRepos,
		reposRead: r.reposRead,
		languages: r.languages,
		lastPushMonth: r.lastPushMonth,
		reposPushedLastYear: r.reposPushedLastYear,
		createdOn: r.createdOn
	};
	return {
		source: 'github',
		factType: 'repo_languages',
		// The account id: a renamed account stays the same record.
		sourceRecordRef: `github:user:${r.id}`,
		eventKey: `profile:github:${r.login.toLowerCase()}`,
		payload,
		payloadSha256: sha256Hex(canonicalJson(payload)),
		occurredOn: r.lastPushMonth === null ? null : `${r.lastPushMonth}-01`
	};
}

function receiptPayload(draft: FactDraft): ProfileReceiptPayload {
	return draft.source === 'codeforces'
		? { source: 'codeforces', factType: 'platform_rating', payload: draft.payload as CodeforcesPayload }
		: { source: 'github', factType: 'repo_languages', payload: draft.payload as GithubPayload };
}

export interface EvidenceContext {
	actor: AuditActor;
	requestId: string;
	createdBy: JobCreator;
	/** Signs the candidate's own receipt of a new fact version. */
	signer: ReceiptSigner;
}

export interface FactChange {
	inserted: number;
	receipts: number;
	unchanged: number;
	superseded: number;
	withdrawn: number;
	profileRevision: number | null;
}

/** Active facts of a candidate's profile on the platform: one profile per platform, so the source names them. */
function activeFacts(tx: Transaction, candidateId: string, platform: ExternalPlatform) {
	return tx
		.select({
			id: sourceFacts.id,
			sourceRecordRef: sourceFacts.sourceRecordRef,
			payloadSha256: sourceFacts.payloadSha256
		})
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, candidateId),
				eq(sourceFacts.source, platform),
				eq(sourceFacts.ownershipBasis, 'handle_challenge'),
				eq(sourceFacts.status, 'active')
			)
		);
}

async function retire(
	tx: Transaction,
	ids: readonly string[],
	status: 'superseded' | 'withdrawn',
	reason: string
): Promise<void> {
	if (ids.length === 0) return;
	await retireFacts(tx, [inArray(sourceFacts.id, [...ids])], status, reason);
}

/**
 * Brings the candidate's facts of the platform to a reading in the caller's transaction (the candidate row locked): the
 * same payload is re-verified, a new one supersedes the old version, `null` — the source has no such profile any
 * more — withdraws it.
 */
export async function applyReading(
	tx: Transaction,
	input: {
		candidateId: string;
		profileId: string;
		platform: ExternalPlatform;
		reading: ProfileReading | null;
		withdrawReason: string;
		now: Date;
	},
	context: EvidenceContext
): Promise<FactChange> {
	const { candidateId, profileId, platform, now } = input;
	const current = await activeFacts(tx, candidateId, platform);
	const change: FactChange = {
		inserted: 0,
		receipts: 0,
		unchanged: 0,
		superseded: 0,
		withdrawn: 0,
		profileRevision: null
	};

	if (input.reading === null) {
		await retire(
			tx,
			current.map((fact) => fact.id),
			'withdrawn',
			input.withdrawReason
		);
		change.withdrawn = current.length;
	} else {
		const draft = readingFact(input.reading);
		const same = current.find(
			(fact) => fact.sourceRecordRef === draft.sourceRecordRef && fact.payloadSha256 === draft.payloadSha256
		);
		if (same) {
			await tx.update(sourceFacts).set({ lastVerifiedAt: now }).where(eq(sourceFacts.id, same.id));
			change.unchanged = 1;
		}
		const stale = current.filter((fact) => fact.id !== same?.id).map((fact) => fact.id);
		await retire(tx, stale, 'superseded', 'source_new_version');
		change.superseded = stale.length;
		if (!same) {
			const [row] = await tx
				.insert(sourceFacts)
				.values({
					candidateId,
					source: draft.source,
					factType: draft.factType,
					sourceRecordRef: draft.sourceRecordRef,
					eventKey: draft.eventKey,
					trustLevel: 'public_verifiable',
					ownershipBasis: 'handle_challenge',
					ownershipRef: profileId,
					payload: draft.payload,
					payloadSha256: draft.payloadSha256,
					// The reading is the snapshot of the source a receipt commits to.
					sourceSnapshotSha256: draft.payloadSha256,
					observedAt: now,
					lastVerifiedAt: now,
					occurredOn: draft.occurredOn,
					status: 'active'
				})
				.returning({ id: sourceFacts.id });
			if (!row) throw new Error('source fact was not inserted');
			change.inserted = 1;
			// A receipt only where the published taxonomy has a template for the source and fact type.
			const template = (await loadReceiptTemplates(tx)).get(templateKey(draft.source, draft.factType));
			if (template) {
				const outcome = await issueProfileSelfReceipt(tx, context.signer, template, {
					id: row.id,
					fact: receiptPayload(draft),
					sourceRecordRef: draft.sourceRecordRef,
					payloadSha256: draft.payloadSha256,
					sourceSnapshotSha256: draft.payloadSha256,
					lastVerifiedAt: now
				});
				if (outcome === 'issued') change.receipts = 1;
			}
		}
	}

	const removed = change.superseded + change.withdrawn;
	if (change.inserted > 0 || removed > 0) {
		change.profileRevision = await recordEvidenceChange(tx, {
			candidateId,
			withdrawal: removed > 0,
			reason: input.reading === null ? input.withdrawReason : 'external_profile_changed',
			requestId: context.requestId,
			actor: context.actor,
			createdBy: context.createdBy
		});
	}
	return change;
}
