// Registered job handlers. A module that implements a job type adds its handler here and the type to the `--types`
// list of the worker in compose.yaml; a type from the list without a handler stops the worker at start.
import { testRun } from '$lib/server/assessments/run-job';
import { profileEmbed } from '$lib/server/candidates/embed-job';
import { objectionDeadlineWatch } from '$lib/server/categories/objections';
import { challengeDeliver } from '$lib/server/challenges/deliver';
import { configuredRegistry } from '$lib/server/companies/registry';
import { companyRegistryLookup } from '$lib/server/companies/registry-check';
import { config } from '$lib/server/config';
import { confirmationExpire } from '$lib/server/confirmations/requests';
import { candidateMajorityTransition, scheduleMajorityTransitions } from '$lib/server/consent/majority';
import { demoReset } from '$lib/server/demo/job';
import { demoPurge } from '$lib/server/demo/purge-job';
import { embeddingReindex } from '$lib/server/embeddings/reindex';
import { derivationsReconcile } from '$lib/server/derivations/reconcile';
import { evidenceCompute } from '$lib/server/evidence/job';
import { eventDeliver } from '$lib/server/events/deliver';
import { consentRevocationCleanup } from '$lib/server/erasure/fsp-import';
import { accountPurge } from '$lib/server/erasure/purge';
import { externalProfileRefresh, scheduleExternalProfileRefreshes } from '$lib/server/external-profiles/refresh-job';
import { fspSync } from '$lib/server/fsp/sync';
import { hiringOutcomeRequest } from '$lib/server/hiring/jobs';
import { invitationExpire, invitationRemindDue } from '$lib/server/invitations/jobs';
import { marketRefresh } from '$lib/server/market/refresh';
import { matchRefresh } from '$lib/server/matching/refresh';
import { notificationDeliver } from '$lib/server/notifications/deps';
import { resumeExtract } from '$lib/server/resumes/extract-job';
import { resumeParse } from '$lib/server/resumes/parse-job';
import { vacancyEmbed } from '$lib/server/vacancies/embed-job';
import { scheduleTextRecheck, vacanciesTextRecheck } from '$lib/server/vacancies/text-recheck';
import { handlerRegistry } from './handler';
import { retentionSweep } from './retention';
import type { ScheduleTick } from './scheduler';

export const JOB_HANDLERS = handlerRegistry([
	retentionSweep,
	fspSync,
	externalProfileRefresh,
	evidenceCompute,
	matchRefresh,
	derivationsReconcile,
	objectionDeadlineWatch,
	marketRefresh,
	companyRegistryLookup(() => configuredRegistry(config().companyRegistry)),
	invitationExpire,
	invitationRemindDue,
	hiringOutcomeRequest,
	vacanciesTextRecheck,
	vacancyEmbed,
	profileEmbed,
	embeddingReindex,
	resumeParse,
	resumeExtract,
	testRun,
	notificationDeliver,
	demoReset,
	demoPurge,
	consentRevocationCleanup,
	accountPurge,
	candidateMajorityTransition,
	challengeDeliver,
	confirmationExpire,
	eventDeliver
]);

/** Schedules with their own timetables, ticked by a worker that runs their job type. */
export const SCHEDULE_TICKS: readonly ScheduleTick[] = [
	{
		// Daily: adults whose consents or representation still date from minority (domain 7.3).
		type: 'candidate.majority_transition',
		tick: scheduleMajorityTransitions
	},
	{
		// Daily: verified public profiles not read for a day (domain 9.4).
		type: 'external_profile.refresh',
		tick: scheduleExternalProfileRefreshes
	},
	{
		// From the start of a worker: while vacancies carry the check of another validator version (domain 13.1).
		type: 'vacancies.text_recheck',
		tick: (db) => scheduleTextRecheck(db)
	}
];
