// The demo actor (docs/domain.md, section 19.3): an account of the demo seed — an original of the scenario cast or an
// account of the background — or a clone of a demo session. Any visitor of a demonstration stand opens a demo session
// and acts in it as the FSP operator or the administrator, and the originals are the template every new session copies,
// so besides the lists (`demo/scope.ts`) the server keeps a second barrier here:
// - an action that changes what every visitor of the stand shares — a batch of FSP results, staff roles, the model
//   modes — is refused to every demo actor (`requireStandChange`);
// - the reach of a staff member (`StaffReach`) is the rows of their own place: a clone reaches the rows of its demo
//   session only — the queues and cases of the operator, the files of the cases, the accounts and staff roles of the
//   administrator cabinet, the journal. Rows outside sessions (real accounts, the originals, the background) do not
//   exist for it, even where the catalog of its employers shows them: a decision on a shared row would reach every
//   other visitor and the real people of the stand. A real account and an account of the seed reach the rows outside
//   sessions: the seed stages the scenario through the product's own actions under the original operator, and
//   visitors never hold an account of the seed (FSP ID refuses to sign in to it, its password is not handed out).
import { eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import type { AccessSubject } from './permissions';

export const DEMO_LOCK_MESSAGE =
	'В демо недоступно: это действие изменило бы стенд для всех посетителей. Здесь его можно посмотреть, но не выполнить.';

export type DemoActor =
	| { kind: 'person' }
	/** An account of the demo seed outside sessions: an original of the cast or an account of the background. */
	| { kind: 'seeded' }
	| { kind: 'clone'; sessionId: string };

const PERSON: DemoActor = { kind: 'person' };

/** What an account is among demo accounts, read from the database on this request; no account is a person. */
export async function demoActorOf(executor: Executor, userId: string | null): Promise<DemoActor> {
	if (userId === null) return PERSON;
	const [row] = await executor
		.select({ batch: users.seedBatchId, session: users.demoSessionId })
		.from(users)
		.where(eq(users.id, userId));
	if (!row) throw new ApiError('unauthenticated');
	if (row.session !== null) return { kind: 'clone', sessionId: row.session };
	return row.batch === null ? PERSON : { kind: 'seeded' };
}

export const isDemoActor = (actor: DemoActor): boolean => actor.kind !== 'person';

/** Whether the subject is a demo actor, for the screens that show a closed action as «в демо недоступно». */
export async function standChangesLocked(executor: Executor, subject: AccessSubject): Promise<boolean> {
	return isDemoActor(await demoActorOf(executor, subject.userId));
}

/** `403` with the demo explanation for an action that changes what every visitor of the stand shares. */
export async function requireStandChange(executor: Executor, subject: AccessSubject): Promise<void> {
	if (await standChangesLocked(executor, subject)) {
		throw new ApiError('forbidden', { message: DEMO_LOCK_MESSAGE });
	}
}

/**
 * The rows a staff member reaches: those of their demo session for a clone (`session`), those outside every session
 * for anybody else (`session: null`). A row out of reach is «not found», as one that does not exist.
 */
export class StaffReach {
	readonly actor: DemoActor;
	/** The demo session whose rows are reached; `null` — the rows outside sessions. */
	readonly session: string | null;

	private constructor(actor: DemoActor, session: string | null) {
		this.actor = actor;
		this.session = session;
	}

	static async of(executor: Executor, subject: AccessSubject): Promise<StaffReach> {
		const actor = await demoActorOf(executor, subject.userId);
		return new StaffReach(actor, actor.kind === 'clone' ? actor.sessionId : null);
	}

	/** The row with the demo session `rowSession` is reached. */
	includes(rowSession: string | null): boolean {
		return rowSession === this.session;
	}

	/** `not_found` for a row out of reach. */
	require(rowSession: string | null): void {
		if (!this.includes(rowSession)) throw new ApiError('not_found');
	}

	/** `includes` as a condition over the demo session column of a root (`users`, `candidates`, `companies`). */
	rows(sessionColumn: AnyColumn | SQL): SQL {
		return this.session === null
			? sql`(${sessionColumn} is null)`
			: sql`coalesce(${sessionColumn} = ${this.session}::uuid, false)`;
	}

	/** The candidate named by the expression is reached. */
	candidate(candidateId: AnyColumn | SQL): SQL {
		return sql`exists (select 1 from candidates reach_candidate
			where reach_candidate.id = ${candidateId} and ${this.rows(sql`reach_candidate.demo_session_id`)})`;
	}

	/** The company named by the expression is reached. */
	company(companyId: AnyColumn | SQL): SQL {
		return sql`exists (select 1 from companies reach_company
			where reach_company.id = ${companyId} and ${this.rows(sql`reach_company.demo_session_id`)})`;
	}

	/** The account named by the expression is reached. */
	user(userId: AnyColumn | SQL): SQL {
		return sql`exists (select 1 from users reach_user
			where reach_user.id = ${userId} and ${this.rows(sql`reach_user.demo_session_id`)})`;
	}

	/**
	 * Events of the journal the reader reaches; `null` — every event. The journal is shared by the stand (domain 19.3), so
	 * a clone reads the events of its own session: those its accounts or companies did, those about its candidates, and
	 * the opening of the session itself.
	 */
	journal(event: {
		actorUserId: AnyColumn;
		actorCompanyId: AnyColumn;
		subjectCandidateId: AnyColumn;
		objectType: AnyColumn;
		objectId: AnyColumn;
	}): SQL | null {
		if (this.session === null) return null;
		return sql`(${this.user(event.actorUserId)} or ${this.company(event.actorCompanyId)}
			or ${this.candidate(event.subjectCandidateId)}
			or (${event.objectType} = 'demo_session' and ${event.objectId} = ${this.session}))`;
	}
}
