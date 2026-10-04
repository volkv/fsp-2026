// `effectiveConsent(candidate, kind, at)` (docs/domain.md, section 6.3) over the events of one consent kind of one
// candidate: the grounds of an achievements import, of the Telegram channel and the consents of catalog visibility
// decide with this one rule. `effectiveConsentOf` and `effectiveConsentsOf` read the events of one or many candidates
// themselves; a caller that reads the events together with other data applies `effectiveConsent`.
import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { candidates, consentEvents, legalDocuments, representations } from '$lib/server/db/schema';
import { ageBand, isMinorBand, type BirthDateInfo } from '$lib/server/visibility/age';
import type { ConsentKind } from './kinds';

/** What the rule reads of a `consent_events` row joined with the version of its document. */
export interface ConsentEventFacts {
	id: string;
	action: 'grant' | 'revoke' | 'lapse';
	signerKind: 'subject' | 'representative' | 'system';
	representationId: string | null;
	occurredAt: Date;
	/** `legal_documents.version` of the document the event refers to. */
	documentVersion: number;
}

const after = (a: ConsentEventFacts, b: ConsentEventFacts) =>
	a.occurredAt.getTime() > b.occurredAt.getTime() || (a.occurredAt.getTime() === b.occurredAt.getTime() && a.id > b.id);

/**
 * The effective grant of one signer side among events ordered by time: its last event is a `grant`, no `revoke` or
 * `lapse` of anybody follows it, and no published version with `requires_reconsent` replaced its document.
 */
export function effectiveGrant<T extends ConsentEventFacts>(
	events: readonly T[],
	side: 'subject' | 'representative',
	reconsentVersions: readonly number[]
): T | null {
	const last = events.filter((e) => e.signerKind === side).at(-1);
	if (last?.action !== 'grant') return null;
	if (events.some((e) => e.action !== 'grant' && after(e, last))) return null;
	if (reconsentVersions.some((version) => version > last.documentVersion)) return null;
	return last;
}

/**
 * The subject's grant in effect at `at`, or `null`:
 * - without a known age neither the minor nor the adult rule can be checked, and under 14 there is no processing
 *   (domain 7.2, 7.3);
 * - for ages 14–17 together with a grant of a representative whose authority is verified;
 * - an adult's own grant counts only when signed after majority; earlier ones lapse at 18 (domain 6.3, rule 4).
 *
 * `events` are the events of one kind of the candidate up to `at`, ordered by `occurred_at`, then by id;
 * `reconsentVersions` — versions of the kind's document published with `requires_reconsent` up to `at`.
 */
export function effectiveConsent<T extends ConsentEventFacts>(
	events: readonly T[],
	context: {
		birth: BirthDateInfo;
		at: Date;
		reconsentVersions: readonly number[];
		verifiedRepresentationIds: ReadonlySet<string>;
	}
): T | null {
	const { birth, at, reconsentVersions } = context;
	const band = ageBand(birth, at);
	if (band === 'unknown' || band === 'under_14') return null;
	const subject = effectiveGrant(events, 'subject', reconsentVersions);
	if (!subject) return null;
	if (isMinorBand(band)) {
		const representative = effectiveGrant(events, 'representative', reconsentVersions);
		return representative?.representationId && context.verifiedRepresentationIds.has(representative.representationId)
			? subject
			: null;
	}
	return ageBand(birth, subject.occurredAt) === 'adult' ? subject : null;
}

/**
 * The id of the candidate's grant of `kind` in effect at `at`, or `null` when there is none (or no such candidate).
 */
export async function effectiveConsentOf(
	executor: Executor,
	candidateId: string,
	kind: ConsentKind,
	at: Date
): Promise<string | null> {
	return (await effectiveConsentsOf(executor, [candidateId], kind, at)).get(candidateId) ?? null;
}

/**
 * The ids of the candidates' grants of `kind` in effect at `at`, by candidate; a candidate without one is absent. Reads
 * the candidates' ages, the events of the kind up to `at`, the versions requiring a new consent and the representatives
 * whose authority is verified in one pass, then applies `effectiveConsent` to each candidate.
 */
export async function effectiveConsentsOf(
	executor: Executor,
	candidateIds: readonly string[],
	kind: ConsentKind,
	at: Date
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const ids = [...new Set(candidateIds)];
	if (ids.length === 0) return result;
	const rows = await executor
		.select({
			id: candidates.id,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(inArray(candidates.id, ids));

	const events = await executor
		.select({
			id: consentEvents.id,
			candidateId: consentEvents.subjectCandidateId,
			action: consentEvents.action,
			signerKind: consentEvents.signerKind,
			representationId: consentEvents.representationId,
			occurredAt: consentEvents.occurredAt,
			documentVersion: legalDocuments.version
		})
		.from(consentEvents)
		.innerJoin(legalDocuments, eq(legalDocuments.id, consentEvents.documentId))
		.where(
			and(
				inArray(consentEvents.subjectCandidateId, ids),
				eq(consentEvents.kind, kind),
				lte(consentEvents.occurredAt, at)
			)
		)
		.orderBy(asc(consentEvents.occurredAt), asc(consentEvents.id));
	if (events.length === 0) return result;
	const eventsOf = new Map<string, ConsentEventFacts[]>();
	for (const event of events) {
		const list = eventsOf.get(event.candidateId) ?? [];
		list.push(event);
		eventsOf.set(event.candidateId, list);
	}

	const reconsent = await executor
		.select({ version: legalDocuments.version })
		.from(legalDocuments)
		.where(
			and(
				eq(legalDocuments.kind, kind),
				eq(legalDocuments.requiresReconsent, true),
				isNotNull(legalDocuments.publishedAt),
				lte(legalDocuments.publishedAt, at)
			)
		);

	const representationIds = [...new Set(events.flatMap((e) => (e.representationId ? [e.representationId] : [])))];
	const verified =
		representationIds.length === 0
			? []
			: await executor
					.select({ id: representations.id })
					.from(representations)
					.where(and(inArray(representations.id, representationIds), eq(representations.status, 'authority_verified')));
	const verifiedRepresentationIds = new Set(verified.map((r) => r.id));
	const reconsentVersions = reconsent.map((r) => r.version);

	for (const row of rows) {
		const grant = effectiveConsent(eventsOf.get(row.id) ?? [], {
			birth: { birthDate: row.birthDate, precision: row.precision, status: row.status },
			at,
			reconsentVersions,
			verifiedRepresentationIds
		});
		if (grant) result.set(row.id, grant.id);
	}
	return result;
}

/** Each side of one consent kind of a candidate at `at`: what the candidate and the representative signed. */
export interface ConsentSides {
	/** The candidate's own grant in force (for an adult — signed after majority); `null` — none. */
	subject: ConsentEventFacts | null;
	/** The grant of the representation `representationId` in force; `null` — none, or no representation asked. */
	representative: ConsentEventFacts | null;
	/** `effectiveConsent` of the kind. */
	effective: boolean;
}

/**
 * The sides of the candidate's consents of `kinds` at `at`: the candidate's own grant and the grant of the given
 * representation, each as the rule of `effectiveConsent` counts it, and whether the consent is in effect. What the
 * candidate and a representative see about their signatures.
 */
export async function consentSides<K extends ConsentKind>(
	executor: Executor,
	candidateId: string,
	kinds: readonly K[],
	representationId: string | null,
	at: Date
): Promise<Map<K, ConsentSides>> {
	const [candidate] = await executor
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate) throw new Error(`candidate ${candidateId} does not exist`);
	const birth: BirthDateInfo = candidate;
	const result = new Map<K, ConsentSides>();
	for (const kind of kinds) {
		const events = await executor
			.select({
				id: consentEvents.id,
				action: consentEvents.action,
				signerKind: consentEvents.signerKind,
				representationId: consentEvents.representationId,
				occurredAt: consentEvents.occurredAt,
				documentVersion: legalDocuments.version
			})
			.from(consentEvents)
			.innerJoin(legalDocuments, eq(legalDocuments.id, consentEvents.documentId))
			.where(
				and(
					eq(consentEvents.subjectCandidateId, candidateId),
					eq(consentEvents.kind, kind),
					lte(consentEvents.occurredAt, at)
				)
			)
			.orderBy(asc(consentEvents.occurredAt), asc(consentEvents.id));
		const reconsentVersions = (
			await executor
				.select({ version: legalDocuments.version })
				.from(legalDocuments)
				.where(
					and(
						eq(legalDocuments.kind, kind),
						eq(legalDocuments.requiresReconsent, true),
						isNotNull(legalDocuments.publishedAt),
						lte(legalDocuments.publishedAt, at)
					)
				)
		).map((row) => row.version);
		const subject = effectiveGrant(events, 'subject', reconsentVersions);
		const representative =
			representationId === null
				? null
				: effectiveGrant(
						events.filter((e) => e.signerKind !== 'representative' || e.representationId === representationId),
						'representative',
						reconsentVersions
					);
		result.set(kind, {
			subject:
				subject && (isMinorBand(ageBand(birth, at)) || ageBand(birth, subject.occurredAt) === 'adult') ? subject : null,
			representative,
			effective: (await effectiveConsentsOf(executor, [candidateId], kind, at)).has(candidateId)
		});
	}
	return result;
}
