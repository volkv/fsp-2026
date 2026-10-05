// Registered job handlers. A module that implements a job type adds its handler here and the type to the `--types`
// list of the worker in compose.yaml; a type from the list without a handler stops the worker at start.
import { assessmentRun } from '$lib/server/assessments/run-job';
import { profileEmbed } from '$lib/server/candidates/embed-job';
import { objectionDeadlineWatch } from '$lib/server/categories/objections';
import { configuredRegistry } from '$lib/server/companies/registry';
import { companyRegistryLookup } from '$lib/server/companies/registry-check';
import { config } from '$lib/server/config';
import { candidateMajorityTransition, scheduleMajorityTransitions } from '$lib/server/consent/majority';
import { demoReset } from '$lib/server/demo/job';
import { demoPurge } from '$lib/server/demo/purge-job';
import { embeddingReindex } from '$lib/server/embeddings/reindex';
import { derivationsReconcile } from '$lib/server/derivations/reconcile';
import { evidenceCompute } from '$lib/server/evidence/job';
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
import { vacanciesFreshnessCheck } from '$lib/server/vacancies/freshness-job';
import { vacanciesImport } from '$lib/server/vacancies/import-job';
import { vacancyNormalize } from '$lib/server/vacancies/normalize-job';
import { scheduleVacancyImports } from '$lib/server/vacancies/schedule';
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
	vacanciesImport,
	vacanciesFreshnessCheck,
	vacancyNormalize,
	vacanciesTextRecheck,
	vacancyEmbed,
	profileEmbed,
	embeddingReindex,
	resumeParse,
	resumeExtract,
	assessmentRun,
	notificationDeliver,
	demoReset,
	demoPurge,
	consentRevocationCleanup,
	accountPurge,
	candidateMajorityTransition
]);

/** Schedules with their own timetables, ticked by a worker that runs their job type. */
export const SCHEDULE_TICKS: readonly ScheduleTick[] = [
	{
		// Each source by its own schedule (`vacancy_sources.schedule`).
		type: 'vacancies.import',
		tick: async (db, now) => (await scheduleVacancyImports(db, now)).length
	},
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
