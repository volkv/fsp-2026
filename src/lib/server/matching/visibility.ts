// Facts of `canShow` (docs/domain.md, section 7.4) read for many candidates at once: catalog search and pool counters
// decide visibility with the same pure function as a single card. Consents follow `effectiveConsent` (domain 6.3).
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { rolesOf, type AccessSubject } from '$lib/server/access/permissions';
import { minorTermsAcceptance } from '$lib/server/companies/profile';
import { effectiveConsent, type ConsentEventFacts } from '$lib/server/consent/effective';
import { CATALOG_SCOPE_FIELDS, parsePolicyParams, type CatalogScopeField } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import {
	candidateCompanyBlocks,
	candidates,
	consentEvents,
	legalDocuments,
	productPolicies,
	representations
} from '$lib/server/db/schema';
import type { BirthDateInfo } from '$lib/server/visibility/age';
import type { Viewer, VisibilityFacts } from '$lib/server/visibility/can-show';

interface ConsentRow extends ConsentEventFacts {
	candidateId: string;
	kind: 'pd_processing' | 'catalog_visibility';
	scopeFields: string[] | null;
}

export interface VisibilityPolicy {
	policyVersion: string;
	minorsEnabled: boolean;
}

/**
 * The `minor_policy` in force. Without a published policy minors are not shown: whether the product works with 14–17
 * is a decision of the brief (domain 7.3), and absence of that decision is not consent to it.
 */
export async function loadVisibilityPolicy(executor: Executor, now: Date): Promise<VisibilityPolicy> {
	const [row] = await executor
		.select({ version: productPolicies.version, params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, 'minor_policy'), lte(productPolicies.effectiveFrom, now)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	if (!row) return { policyVersion: 'minor_policy:none', minorsEnabled: false };
	return {
		policyVersion: `minor_policy:${row.version}`,
		minorsEnabled: parsePolicyParams('minor_policy', row.params).enabled
	};
}

export interface CatalogViewer {
	viewer: Extract<Viewer, { kind: 'member' }>;
	company: NonNullable<VisibilityFacts['viewerCompany']>;
}

/**
 * The viewer of a catalog as `canShow` sees it, from the subject read on this request. `null` — the subject is not a
 * member of a company. Whether the member may search at all is `can(subject, 'catalog.search')`, checked by the caller.
 */
export async function loadCatalogViewer(
	executor: Executor,
	subject: AccessSubject,
	now: Date
): Promise<CatalogViewer | null> {
	const membership = subject.membership;
	if (subject.userId === null || membership === null || subject.via === 'anonymous') return null;
	const roles = rolesOf(subject);
	const hasCardReadPermission =
		(roles.has('owner') || roles.has('recruiter')) &&
		(subject.via !== 'api_key' || subject.apiKeyPermissions?.includes('candidate.card.read') === true);
	return {
		viewer: {
			kind: 'member',
			userId: subject.userId,
			memberId: membership.memberId,
			companyId: membership.companyId,
			via: subject.via,
			demoSessionId: await demoSessionOfUser(executor, subject.userId)
		},
		company: {
			membershipActive: membership.status === 'active',
			companyVerified: membership.companyStatus === 'verified',
			hasCardReadPermission,
			minorTermsAccepted: (await minorTermsAcceptance(executor, membership.companyId, now)) !== null
		}
	};
}

export interface VisibilityContext {
	now: Date;
	policy: VisibilityPolicy;
	/** Company whose block list matters; `null` — no company viewer (anonymous counters). */
	viewerCompanyId: string | null;
	viewerCompany?: VisibilityFacts['viewerCompany'];
	vacancy?: VisibilityFacts['vacancy'];
}

/** `VisibilityFacts` of each candidate, read at `context.now`. */
export async function loadVisibilityFacts(
	executor: Executor,
	candidateIds: readonly string[],
	context: VisibilityContext
): Promise<Map<string, VisibilityFacts>> {
	const result = new Map<string, VisibilityFacts>();
	if (candidateIds.length === 0) return result;
	const ids = [...new Set(candidateIds)];
	const { now } = context;

	const rows = await executor
		.select({
			id: candidates.id,
			userId: candidates.userId,
			status: candidates.status,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus,
			visibility: candidates.visibility,
			searchStatus: candidates.searchStatus,
			demoSessionId: candidates.demoSessionId,
			demoOriginal: candidates.demoOriginal
		})
		.from(candidates)
		.where(inArray(candidates.id, ids));

	const blocked = new Set(
		context.viewerCompanyId === null
			? []
			: (
					await executor
						.select({ candidateId: candidateCompanyBlocks.candidateId })
						.from(candidateCompanyBlocks)
						.where(
							and(
								inArray(candidateCompanyBlocks.candidateId, ids),
								eq(candidateCompanyBlocks.companyId, context.viewerCompanyId)
							)
						)
				).map((row) => row.candidateId)
	);

	const events: ConsentRow[] = await executor
		.select({
			id: consentEvents.id,
			candidateId: consentEvents.subjectCandidateId,
			kind: sql<ConsentRow['kind']>`${consentEvents.kind}`,
			action: consentEvents.action,
			signerKind: consentEvents.signerKind,
			representationId: consentEvents.representationId,
			scopeFields: consentEvents.scopeFields,
			occurredAt: consentEvents.occurredAt,
			documentVersion: legalDocuments.version
		})
		.from(consentEvents)
		.innerJoin(legalDocuments, eq(legalDocuments.id, consentEvents.documentId))
		.where(
			and(
				inArray(consentEvents.subjectCandidateId, ids),
				inArray(consentEvents.kind, ['pd_processing', 'catalog_visibility']),
				lte(consentEvents.occurredAt, now)
			)
		)
		.orderBy(asc(consentEvents.occurredAt), asc(consentEvents.id));

	const reconsent = await executor
		.select({ kind: legalDocuments.kind, version: legalDocuments.version })
		.from(legalDocuments)
		.where(
			and(
				inArray(legalDocuments.kind, ['pd_processing', 'catalog_visibility']),
				eq(legalDocuments.requiresReconsent, true),
				isNotNull(legalDocuments.publishedAt),
				lte(legalDocuments.publishedAt, now)
			)
		);
	const reconsentOf = (kind: ConsentRow['kind']) => reconsent.filter((r) => r.kind === kind).map((r) => r.version);

	const verified = await executor
		.select({ id: representations.id, candidateId: representations.candidateId })
		.from(representations)
		.where(and(inArray(representations.candidateId, ids), eq(representations.status, 'authority_verified')));
	const verifiedIds = new Set(verified.map((r) => r.id));
	const withVerifiedRepresentative = new Set(verified.map((r) => r.candidateId));

	const eventsOf = new Map<string, ConsentRow[]>();
	for (const event of events) {
		const key = `${event.candidateId}:${event.kind}`;
		const list = eventsOf.get(key) ?? [];
		list.push(event);
		eventsOf.set(key, list);
	}

	for (const row of rows) {
		const birth: BirthDateInfo = { birthDate: row.birthDate, precision: row.precision, status: row.birthStatus };
		const consent = (kind: ConsentRow['kind']) =>
			effectiveConsent(eventsOf.get(`${row.id}:${kind}`) ?? [], {
				birth,
				at: now,
				reconsentVersions: reconsentOf(kind),
				verifiedRepresentationIds: verifiedIds
			});
		const catalogGrant = consent('catalog_visibility');
		result.set(row.id, {
			now,
			policyVersion: context.policy.policyVersion,
			minorsEnabled: context.policy.minorsEnabled,
			// The public page is not part of the catalog; its availability is not read here.
			publicDistributionAvailable: false,
			candidate: {
				id: row.id,
				userId: row.userId,
				status: row.status,
				birth,
				visibility: row.visibility,
				searchStatus: row.searchStatus,
				blockedCompanyIds: blocked.has(row.id) && context.viewerCompanyId !== null ? [context.viewerCompanyId] : [],
				demoSessionId: row.demoSessionId,
				demoOriginal: row.demoOriginal
			},
			consents: {
				pdProcessing: consent('pd_processing') !== null,
				catalogVisibility: catalogGrant ? { scopeFields: catalogScopeFields(catalogGrant) } : null,
				publicDistribution: false
			},
			representativeVerified: withVerifiedRepresentative.has(row.id),
			...(context.viewerCompany ? { viewerCompany: context.viewerCompany } : {}),
			...(context.vacancy ? { vacancy: context.vacancy } : {})
		});
	}
	return result;
}

function catalogScopeFields(grant: ConsentRow): CatalogScopeField[] {
	return (grant.scopeFields ?? []).map((field) => {
		const known = CATALOG_SCOPE_FIELDS.find((allowed) => allowed === field);
		if (!known) throw new Error(`catalog_visibility grant ${grant.id} has an unknown scope field`);
		return known;
	});
}
