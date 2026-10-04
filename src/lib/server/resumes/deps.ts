// Dependencies of the candidate's resume actions and the check that the subject acts on their own profile.
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { db, type Database } from '$lib/server/db';
import { ApiError } from '$lib/server/errors/api-error';
import { objectStore, type ObjectStore } from '$lib/server/storage/object-store';

export interface ResumeDeps {
	db: Database;
	store: ObjectStore;
	now: () => Date;
}

/** The configured database and bucket; tests pass their own. */
export function resumeDeps(): ResumeDeps {
	return { db: db(), store: objectStore(), now: () => new Date() };
}

/** The candidate of a session subject allowed to change their own profile (`candidate.self.write`). */
export function selfCandidate(subject: AccessSubject): { candidateId: string; userId: string } {
	const candidateId = subject.candidate?.id;
	if (!candidateId || subject.userId === null || !can(subject, 'candidate.self.write', { candidateId }).allowed) {
		throw new ApiError('forbidden');
	}
	return { candidateId, userId: subject.userId };
}
