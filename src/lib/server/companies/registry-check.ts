// Result of the registry lookup stored with a verification request (`company_verifications.registry_check`, domain
// 5.2) and the job that fills it. The result is a hint for the operator: it never changes the status of the company.
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '$lib/server/db';
import { companies, companyVerifications } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import { nameMatches, type CompanyRegistry, type RegistryLookup } from './registry';

export const registryCheckSchema = z.strictObject({
	status: z.enum(['found', 'not_found', 'unavailable', 'not_configured']),
	source: z.enum(['egrul']).nullable(),
	checked_at: z.iso.datetime({ offset: true }),
	/** The entity is not liquidated; `null` — not found or not checked. */
	active: z.boolean().nullable(),
	name_match: z.boolean().nullable(),
	reason: z.string().nullable()
});

export type RegistryCheck = z.infer<typeof registryCheckSchema>;

export type RegistryCheckState = RegistryCheck['status'] | 'pending';

export function registryCheckOf(lookup: RegistryLookup, legalName: string, at: Date): RegistryCheck {
	const base = { checked_at: at.toISOString() };
	switch (lookup.status) {
		case 'found':
			return {
				...base,
				status: 'found',
				source: lookup.source,
				active: lookup.record.endedOn === null,
				name_match: nameMatches(legalName, lookup.record),
				reason: null
			};
		case 'not_found':
			return { ...base, status: 'not_found', source: lookup.source, active: null, name_match: null, reason: null };
		case 'unavailable':
			return {
				...base,
				status: 'unavailable',
				source: lookup.source,
				active: null,
				name_match: null,
				reason: lookup.reason
			};
		case 'not_configured':
			return { ...base, status: 'not_configured', source: null, active: null, name_match: null, reason: null };
	}
}

/** Reads a stored check; a value that does not match the schema is a programming error. */
export function parseRegistryCheck(value: unknown): RegistryCheck | null {
	return value === null ? null : registryCheckSchema.parse(value);
}

async function openVerification(executor: Executor, companyId: string) {
	const [row] = await executor
		.select({ id: companyVerifications.id, inn: companies.inn, legalName: companies.legalName })
		.from(companyVerifications)
		.innerJoin(companies, eq(companies.id, companyVerifications.companyId))
		.where(
			and(
				eq(companyVerifications.companyId, companyId),
				isNull(companyVerifications.decision),
				eq(companies.status, 'submitted')
			)
		);
	return row ?? null;
}

/**
 * `company.registry_lookup`: looks the taxpayer number of a submitted company up and stores the result with its open
 * verification request. An unavailable source is retried; after the last attempt the state `unavailable` is stored, so
 * the operator sees it instead of a request that waits forever. The registry is resolved on each run, so building the
 * handler registry reads no configuration.
 */
export function companyRegistryLookup(registry: () => CompanyRegistry): JobHandler<'company.registry_lookup'> {
	return defineHandler({
		type: 'company.registry_lookup',
		concurrency: 2,
		async run({ job, db, signal }) {
			const companyId = job.payload.company_id;
			const verification = await openVerification(db, companyId);
			if (!verification || verification.id !== job.inputVersion) {
				return { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };
			}
			const lookup = await registry().lookup(verification.inn, signal);
			if (lookup.status === 'unavailable' && job.attempt < job.maxAttempts) {
				throw new JobFailure('registry_unavailable', `registry ${lookup.source} unavailable: ${lookup.reason}`, {
					retryable: true
				});
			}
			const check = registryCheckOf(lookup, verification.legalName, new Date());
			return {
				isCurrent: async (tx) => (await openVerification(tx, companyId))?.id === verification.id,
				write: async (tx) => {
					await tx
						.update(companyVerifications)
						.set({ registryCheck: check })
						.where(eq(companyVerifications.id, verification.id));
					await tx
						.update(companies)
						.set({ registrySnapshot: lookup.status === 'found' ? lookup.record : null })
						.where(eq(companies.id, companyId));
				},
				describe: () => ({ status: check.status })
			};
		}
	});
}
