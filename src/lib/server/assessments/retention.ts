// Retention of attempt artifacts (docs/domain.md, 10.4): after `retention_until` the content and the file of an artifact
// are removed under the retention role; the row, its hash and the score stay, so the score keeps its grounds' trace.
// A large artifact lives in the storage as a `files` row of purpose `assessment_artifact`: its object is removed first
// (`expiredArtifactFiles` names them), and only then the reference and the row go, for the objects the caller removed.
// An artifact whose object was not removed keeps its content, reference and file row until the next sweep.
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { assessmentArtifacts, files } from '$lib/server/db/schema';

export interface ArtifactFile {
	id: string;
	storageKey: string;
}

/** The files of the artifacts whose retention ended before `today` (a date `YYYY-MM-DD`). */
export async function expiredArtifactFiles(executor: Executor, today: string): Promise<ArtifactFile[]> {
	return executor
		.select({ id: files.id, storageKey: files.storageKey })
		.from(assessmentArtifacts)
		.innerJoin(files, eq(files.id, assessmentArtifacts.fileId))
		.where(lt(assessmentArtifacts.retentionUntil, today));
}

export interface ArtifactsCleared {
	/** Artifacts that lost their content and their file. */
	artifacts: number;
	/** `files` rows removed with their objects. */
	files: number;
}

/**
 * Clears the artifacts whose retention ended before `today`: the content and the file at once, as the table allows
 * (migration 0002). An artifact with a file is cleared only if its object is among `removedKeys` — the objects the
 * caller has already removed from the storage; otherwise it waits whole for the next sweep.
 */
export async function clearExpiredArtifacts(
	tx: Transaction,
	today: string,
	removedKeys: ReadonlySet<string>
): Promise<ArtifactsCleared> {
	const fileIds = (await expiredArtifactFiles(tx, today))
		.filter((file) => removedKeys.has(file.storageKey))
		.map((file) => file.id);
	const withoutPendingFile =
		fileIds.length === 0
			? isNull(assessmentArtifacts.fileId)
			: or(isNull(assessmentArtifacts.fileId), inArray(assessmentArtifacts.fileId, fileIds));
	// The table is append-only: only the retention role updates it (migration 0002).
	await tx.execute(sql`set local role fsp_retention`);
	const cleared = await tx
		.update(assessmentArtifacts)
		.set({ content: null, fileId: null })
		.where(
			and(
				lt(assessmentArtifacts.retentionUntil, today),
				or(isNotNull(assessmentArtifacts.content), isNotNull(assessmentArtifacts.fileId)),
				withoutPendingFile
			)
		)
		.returning({ id: assessmentArtifacts.id });
	await tx.execute(sql`reset role`);
	const removedFiles =
		fileIds.length === 0 ? [] : await tx.delete(files).where(inArray(files.id, fileIds)).returning({ id: files.id });
	return { artifacts: cleared.length, files: removedFiles.length };
}
