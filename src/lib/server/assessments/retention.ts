// Retention of attempt artifacts (docs/domain.md, 10.7): after `retention_until` the content and the file of an artifact
// are removed under the retention role; the row, its hash and the score stay, so the score keeps its grounds' trace.
// A large artifact lives in the storage as a `files` row of purpose `assessment_artifact`: its object is removed first
// (`expiredArtifactFiles` names them), and only then the reference and the row go, for the objects the caller removed.
// An artifact whose object was not removed keeps its content, reference and file row until the next sweep. Artifacts of
// an attempt with an open objection are not cleared.
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { assessmentObjections, files, gradeDecisions, testArtifacts } from '$lib/server/db/schema';

export interface ArtifactFile {
	id: string;
	storageKey: string;
}

/**
 * The attempt of the artifact has no open objection: its artifacts are the evidence of the review and wait for it,
 * whatever their date (domain 10.7).
 */
const noOpenObjection = sql`not exists (
	select 1 from ${assessmentObjections}
	join ${gradeDecisions} on ${gradeDecisions.id} = ${assessmentObjections.decisionId}
	where ${gradeDecisions.attemptId} = ${testArtifacts.attemptId}
		and ${assessmentObjections.status} in ('open', 'in_review')
)`;

/** The files of the artifacts whose retention ended before `today` (a date `YYYY-MM-DD`). */
export async function expiredArtifactFiles(executor: Executor, today: string): Promise<ArtifactFile[]> {
	return executor
		.select({ id: files.id, storageKey: files.storageKey })
		.from(testArtifacts)
		.innerJoin(files, eq(files.id, testArtifacts.fileId))
		.where(and(lt(testArtifacts.retentionUntil, today), noOpenObjection));
}

export interface ArtifactsCleared {
	/** Artifacts that lost their content and their file. */
	artifacts: number;
	/** `files` rows removed with their objects. */
	files: number;
}

/**
 * Clears the artifacts whose retention ended before `today`: the content and the file at once, as the table allows
 * (the trigger of the migration of `test_artifacts`). An artifact with a file is cleared only if its object is among
 * `removedKeys` — the objects the caller has already removed from the storage; otherwise it waits whole for the next
 * sweep.
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
			? isNull(testArtifacts.fileId)
			: or(isNull(testArtifacts.fileId), inArray(testArtifacts.fileId, fileIds));
	// The table is append-only: only the retention role updates it (the trigger of the migration of `test_artifacts`).
	await tx.execute(sql`set local role fsp_retention`);
	const cleared = await tx
		.update(testArtifacts)
		.set({ content: null, fileId: null })
		.where(
			and(
				lt(testArtifacts.retentionUntil, today),
				noOpenObjection,
				or(isNotNull(testArtifacts.content), isNotNull(testArtifacts.fileId)),
				withoutPendingFile
			)
		)
		.returning({ id: testArtifacts.id });
	await tx.execute(sql`reset role`);
	const removedFiles =
		fileIds.length === 0 ? [] : await tx.delete(files).where(inArray(files.id, fileIds)).returning({ id: files.id });
	return { artifacts: cleared.length, files: removedFiles.length };
}
