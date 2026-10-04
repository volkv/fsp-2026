// What the candidate states about the search (docs/domain.md, sections 7.1, 13.4): work terms, salary expectation,
// desired roles and the search status. Matching reads all of them, so every change moves `profile_revision` and enqueues
// the recalculation of the candidate's matches in the same transaction; desired roles are an input of the
// categorization and of the profile vectors as well. Permission checks are `candidate.self.write`.
import { and, eq, sql } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import type { Database, Transaction } from '$lib/server/db';
import { candidates, jobs } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { regionReference } from '$lib/server/regions';
import { enqueueProfileEmbed } from './embed-job';
import { candidatePreferencesSchema, type CandidatePreferences } from './preferences';
import { currentCandidateVocabulary } from './vocabulary';

export const SEARCH_STATUSES = ['active', 'open_to_offers', 'not_looking'] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];

/** Desired roles a candidate may name (domain 7.1). */
export const MAX_DESIRED_ROLES = 3;

function writableCandidate(subject: AccessSubject): string {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined) throw new ApiError('forbidden');
	const access = can(subject, 'candidate.self.write', { candidateId });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	return candidateId;
}

const creatorOf = (subject: AccessSubject): JobCreator =>
	subject.userId === null ? { kind: 'system' } : { kind: 'user', id: subject.userId };

/**
 * Moves `profile_revision` of a changed profile and enqueues what reads it: the matches always; the categorization when
 * its input changed, and also when a calculation is running now — it read the previous revision and its result will be
 * discarded as stale, so the new revision needs its own run (domain 17.1).
 */
export async function recordProfileChange(
	tx: Transaction,
	candidateId: string,
	change: { categorizationInput: boolean; createdBy: JobCreator }
): Promise<number> {
	const [row] = await tx
		.update(candidates)
		.set({ profileRevision: sql`${candidates.profileRevision} + 1` })
		.where(eq(candidates.id, candidateId))
		.returning({ revision: candidates.profileRevision });
	if (!row) throw new Error(`candidate ${candidateId} is missing`);
	const inputVersion = String(row.revision);
	let categorize = change.categorizationInput;
	if (!categorize) {
		const [running] = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.dedupKey, `categorization:${candidateId}`), eq(jobs.status, 'running')));
		categorize = running !== undefined;
	}
	if (categorize) {
		await enqueueJob(
			tx,
			'categorization.compute',
			{ candidate_id: candidateId },
			{ inputVersion, createdBy: change.createdBy }
		);
	}
	await enqueueJob(
		tx,
		'match.refresh',
		{ scope: 'candidate', candidate_id: candidateId },
		{ inputVersion, createdBy: change.createdBy }
	);
	return row.revision;
}

function invalid(details: ErrorDetail[]): ApiError {
	return new ApiError('validation_failed', { details });
}

export interface ProfileSettingsInput {
	preferences: CandidatePreferences;
	desiredRoleKeys: readonly string[];
}

/**
 * The candidate's work terms, region and desired roles. Keys are checked against the latest published taxonomy and the
 * region against the reference of regions: a key they do not know is refused, not stored.
 */
export async function updateProfileSettings(
	db: Database,
	subject: AccessSubject,
	input: ProfileSettingsInput
): Promise<void> {
	const candidateId = writableCandidate(subject);
	const parsed = candidatePreferencesSchema.safeParse(input.preferences);
	if (!parsed.success) {
		throw invalid(
			parsed.error.issues.map((issue) => ({
				path: issue.path.join('.'),
				code: issue.code,
				message: issue.message
			}))
		);
	}
	const preferences = parsed.data;
	const desired = [...new Set(input.desiredRoleKeys)];
	const vocabulary = await currentCandidateVocabulary(db);
	if (!vocabulary) throw new ApiError('degraded', { message: 'Справочники ещё не опубликованы' });
	const problems: ErrorDetail[] = [];
	const known = (list: readonly { key: string }[], key: string) => list.some((item) => item.key === key);
	if (desired.length > MAX_DESIRED_ROLES) {
		problems.push({ path: 'desired_role_keys', code: 'too_many', message: `Не больше ${MAX_DESIRED_ROLES} ролей` });
	}
	if (desired.some((key) => !known(vocabulary.roles, key))) {
		problems.push({ path: 'desired_role_keys', code: 'unknown', message: 'Такой роли нет в справочнике' });
	}
	if ((preferences.work_formats ?? []).some((key) => !known(vocabulary.workFormats, key))) {
		problems.push({ path: 'work_formats', code: 'unknown', message: 'Такого формата нет в справочнике' });
	}
	if ((preferences.employment_forms ?? []).some((key) => !known(vocabulary.employmentForms, key))) {
		problems.push({ path: 'employment_forms', code: 'unknown', message: 'Такой занятости нет в справочнике' });
	}
	const regionCode = preferences.region_code;
	if (regionCode !== undefined && !(await regionReference()).has(regionCode)) {
		problems.push({ path: 'region_code', code: 'unknown', message: 'Такого региона нет в справочнике' });
	}
	if (problems.length > 0) throw invalid(problems);

	await db.transaction(async (tx) => {
		const [current] = await tx
			.select({ desired: candidates.desiredRoleKeys })
			.from(candidates)
			.where(eq(candidates.id, candidateId))
			.for('update');
		if (!current) throw new ApiError('not_found');
		const desiredChanged =
			current.desired.length !== desired.length || current.desired.some((key, index) => key !== desired[index]);
		await tx.update(candidates).set({ preferences, desiredRoleKeys: desired }).where(eq(candidates.id, candidateId));
		const createdBy = creatorOf(subject);
		const revision = await recordProfileChange(tx, candidateId, { categorizationInput: desiredChanged, createdBy });
		// Desired roles are a line of the profile text the section vectors are built from; work terms are not in it.
		if (desiredChanged) await enqueueProfileEmbed(tx, candidateId, revision, createdBy);
	});
}

/**
 * Readiness to receive offers. `not_looking` takes the candidate out of the catalog (domain 7.4) without touching the
 * consents; invitations already received stay.
 */
export async function setSearchStatus(db: Database, subject: AccessSubject, status: SearchStatus): Promise<void> {
	const candidateId = writableCandidate(subject);
	if (!SEARCH_STATUSES.includes(status)) {
		throw invalid([{ path: 'search_status', code: 'unknown', message: 'Неизвестный статус поиска' }]);
	}
	await db.transaction(async (tx) => {
		const [current] = await tx
			.select({ status: candidates.searchStatus })
			.from(candidates)
			.where(eq(candidates.id, candidateId))
			.for('update');
		if (!current) throw new ApiError('not_found');
		if (current.status === status) return;
		await tx.update(candidates).set({ searchStatus: status }).where(eq(candidates.id, candidateId));
		await recordProfileChange(tx, candidateId, { categorizationInput: false, createdBy: creatorOf(subject) });
	});
}
