// Registry of background job types (docs/domain.md, section 17.2): payload schema, deduplication key,
// attempts and lease. `input_version` is given at enqueue time by the change that causes the job.
import { z } from 'zod';

interface JobSpec<S extends z.ZodType> {
	/** Handler version; an incompatible payload change is a new version and old jobs are not captured by it. */
	typeVersion: number;
	payload: S;
	/** Key unique among waiting jobs: changes arriving while a job waits join it. */
	dedupKey: (payload: z.infer<S>) => string;
	maxAttempts: number;
	/** How long a capture owns the job without a heartbeat. */
	leaseSeconds: number;
	priority: number;
}

const defineJob = <S extends z.ZodType>(spec: JobSpec<S>) => spec;

const id = z.uuid();
const ids = <K extends string>(...keys: K[]) =>
	z.strictObject(Object.fromEntries(keys.map((key) => [key, id])) as Record<K, typeof id>);
const period = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/, 'must be a date or a date with an hour');

export const JOB_TYPES = {
	'resume.parse': defineJob({
		typeVersion: 1,
		payload: ids('resume_document_id'),
		dedupKey: (p) => `resume.parse:${p.resume_document_id}`,
		maxAttempts: 3,
		leaseSeconds: 180,
		priority: 50
	}),
	'resume.extract': defineJob({
		typeVersion: 1,
		payload: ids('extraction_id'),
		dedupKey: (p) => `resume.extract:${p.extraction_id}`,
		maxAttempts: 3,
		leaseSeconds: 300,
		priority: 50
	}),
	'profile.embed': defineJob({
		typeVersion: 1,
		payload: ids('candidate_id'),
		dedupKey: (p) => `profile.embed:${p.candidate_id}`,
		maxAttempts: 5,
		leaseSeconds: 120,
		priority: 30
	}),
	'vacancy.embed': defineJob({
		typeVersion: 1,
		payload: ids('vacancy_id'),
		dedupKey: (p) => `vacancy.embed:${p.vacancy_id}`,
		maxAttempts: 5,
		leaseSeconds: 120,
		priority: 30
	}),
	'fsp.sync': defineJob({
		typeVersion: 1,
		payload: ids('athlete_link_id'),
		dedupKey: (p) => `fsp.sync:${p.athlete_link_id}`,
		maxAttempts: 5,
		leaseSeconds: 300,
		priority: 60
	}),
	// A reading of a verified public profile of Codeforces or GitHub (domain 9.4): daily, and retried when the source
	// does not answer. The lease covers the spaced calls of Codeforces and the few calls of GitHub.
	'external_profile.refresh': defineJob({
		typeVersion: 1,
		payload: ids('external_profile_id'),
		dedupKey: (p) => `external_profile.refresh:${p.external_profile_id}`,
		maxAttempts: 4,
		leaseSeconds: 300,
		priority: 20
	}),
	'evidence.compute': defineJob({
		typeVersion: 1,
		payload: ids('candidate_id'),
		dedupKey: (p) => `evidence:${p.candidate_id}`,
		maxAttempts: 3,
		leaseSeconds: 120,
		priority: 70
	}),
	'match.refresh': defineJob({
		typeVersion: 1,
		payload: z.discriminatedUnion('scope', [
			z.strictObject({ scope: z.literal('vacancy'), vacancy_id: id }),
			z.strictObject({ scope: z.literal('candidate'), candidate_id: id })
		]),
		dedupKey: (p) => (p.scope === 'vacancy' ? `match:vacancy:${p.vacancy_id}` : `match:candidate:${p.candidate_id}`),
		maxAttempts: 3,
		leaseSeconds: 300,
		priority: 40
	}),
	'derivations.reconcile': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ period }),
		dedupKey: (p) => `reconcile:${p.period}`,
		maxAttempts: 3,
		leaseSeconds: 600,
		priority: 10
	}),
	// Vacancies whose text was checked by another version of the validator are checked again, a batch per run
	// (vacancies/text-recheck.ts). `validator_version` — the version the run brings them to.
	'vacancies.text_recheck': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ validator_version: z.string().min(1) }),
		dedupKey: (p) => `vacancies.text_recheck:${p.validator_version}`,
		maxAttempts: 3,
		leaseSeconds: 300,
		priority: 10
	}),
	'market.refresh': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ period }),
		dedupKey: (p) => `market:${p.period}`,
		maxAttempts: 3,
		leaseSeconds: 600,
		priority: 10
	}),
	// A submission of a practice cluster of the test run in the sandbox (domain 10.3, contracts 6.4–6.5).
	'test.run': defineJob({
		typeVersion: 1,
		payload: ids('artifact_id'),
		dedupKey: (p) => `test.run:${p.artifact_id}`,
		// One retry after a sandbox failure (contracts 6.4).
		maxAttempts: 2,
		leaseSeconds: 120,
		priority: 80
	}),
	'notification.deliver': defineJob({
		typeVersion: 1,
		payload: ids('notification_id', 'channel_id'),
		dedupKey: (p) => `notify:${p.notification_id}:${p.channel_id}`,
		maxAttempts: 5,
		leaseSeconds: 60,
		priority: 60
	}),
	'invitation.remind_due': defineJob({
		typeVersion: 1,
		payload: ids('terms_id'),
		dedupKey: (p) => `invitation.remind:${p.terms_id}`,
		maxAttempts: 3,
		leaseSeconds: 60,
		priority: 50
	}),
	'hiring.outcome_request': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ process_id: id, reminder: z.int().nonnegative() }),
		dedupKey: (p) => `hiring.outcome:${p.process_id}:${p.reminder}`,
		maxAttempts: 3,
		leaseSeconds: 60,
		priority: 40
	}),
	'embedding.reindex': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ space_id: z.string().min(1) }),
		dedupKey: (p) => `reindex:${p.space_id}`,
		maxAttempts: 3,
		leaseSeconds: 1800,
		priority: 5
	}),
	// Physical removal after a withdrawn ground (domain 19.1): a revoked consent, or an unlinked FSP ID — the
	// withdrawal «as a revocation of `fsp_import`» that has no consent event of its own and names the ended link.
	'consent.revocation_cleanup': defineJob({
		typeVersion: 1,
		payload: z.union([ids('consent_event_id'), ids('athlete_link_id')]),
		dedupKey: (p) =>
			'consent_event_id' in p ? `revocation:${p.consent_event_id}` : `revocation:link:${p.athlete_link_id}`,
		maxAttempts: 10,
		leaseSeconds: 300,
		priority: 90
	}),
	'account.purge': defineJob({
		typeVersion: 1,
		payload: ids('user_id'),
		dedupKey: (p) => `purge:${p.user_id}`,
		maxAttempts: 10,
		leaseSeconds: 600,
		priority: 90
	}),
	'candidate.majority_transition': defineJob({
		typeVersion: 1,
		payload: ids('candidate_id'),
		dedupKey: (p) => `majority:${p.candidate_id}`,
		maxAttempts: 5,
		leaseSeconds: 120,
		priority: 80
	}),
	'objection.deadline_watch': defineJob({
		typeVersion: 1,
		payload: ids('objection_id'),
		dedupKey: (p) => `objection:${p.objection_id}`,
		maxAttempts: 5,
		leaseSeconds: 60,
		priority: 60
	}),
	'invitation.expire': defineJob({
		typeVersion: 1,
		payload: ids('terms_id'),
		dedupKey: (p) => `invitation.expire:${p.terms_id}`,
		maxAttempts: 5,
		leaseSeconds: 60,
		priority: 70
	}),
	'retention.sweep': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ date: z.iso.date() }),
		dedupKey: (p) => `retention:${p.date}`,
		maxAttempts: 5,
		leaseSeconds: 1800,
		priority: 5
	}),
	'company.registry_lookup': defineJob({
		typeVersion: 1,
		payload: ids('company_id'),
		dedupKey: (p) => `registry:${p.company_id}`,
		maxAttempts: 5,
		leaseSeconds: 60,
		priority: 50
	}),
	// Demonstration stand only (domain 19.2): empties every table except the reference data, then seeds again. `kind` —
	// `nightly`, the scheduled reset of the night `date`, which runs only while `DEMO_NIGHTLY_RESET` is on when it starts;
	// `startup`, asked for on the day `date` by the start of the application for a batch not seeded yet. One run of each.
	'demo.reset': defineJob({
		typeVersion: 2,
		payload: z.strictObject({ kind: z.enum(['nightly', 'startup']), date: z.iso.date() }),
		dedupKey: (p) => `demo.reset:${p.kind}:${p.date}`,
		maxAttempts: 2,
		leaseSeconds: 1800,
		priority: 100
	}),
	// Calls of companies (domain 13.12): the hourly run delivers each active call whose period of the challenge policy
	// passed on its own clock — the shifted clock of a demo session for the calls of the session's companies.
	'challenge.deliver': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ period }),
		dedupKey: (p) => `challenge.deliver:${p.period}`,
		maxAttempts: 3,
		leaseSeconds: 600,
		priority: 30
	}),
	// A request of a confirmation (domain 13.11) not completed by its deadline expires.
	'confirmation.expire': defineJob({
		typeVersion: 1,
		payload: ids('request_id'),
		dedupKey: (p) => `confirmation.expire:${p.request_id}`,
		maxAttempts: 5,
		leaseSeconds: 60,
		priority: 50
	}),
	// Demonstration stand only (domain 19.3): removes the demo sessions whose time is over. `period` — the hour of the run.
	'demo.purge': defineJob({
		typeVersion: 1,
		payload: z.strictObject({ period }),
		dedupKey: (p) => `demo.purge:${p.period}`,
		maxAttempts: 3,
		leaseSeconds: 900,
		priority: 20
	}),
	// One delivery of an outgoing event of a company to a webhook or an ATS adapter (domain 5.7). The pauses between
	// attempts are the handler's own schedule, from a minute to six hours.
	'event.deliver': defineJob({
		typeVersion: 1,
		payload: ids('delivery_id'),
		dedupKey: (p) => `event.deliver:${p.delivery_id}`,
		maxAttempts: 8,
		leaseSeconds: 120,
		priority: 40
	})
};

export type JobType = keyof typeof JOB_TYPES;
export type JobPayload<T extends JobType> = z.infer<(typeof JOB_TYPES)[T]['payload']>;

export function isJobType(value: string): value is JobType {
	return Object.hasOwn(JOB_TYPES, value);
}

/** Registry entry with the payload type erased, for code that handles jobs of any type. */
export function jobSpec(type: JobType): JobSpec<z.ZodType> {
	return JOB_TYPES[type];
}
