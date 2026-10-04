// Import of a read results batch (docs/contracts.md 1.4, 1.7): a row reaches a person of the platform only through
// the FSP athlete ID it names and an active athlete link of that ID, and only under the candidate's `fsp_import`
// consent in effect — never by name, e-mail or anything else a row says. Rows that reach nobody are counted and left
// in the file; the facts of each linked athlete are compared and written as in the API variant, one transaction per
// athlete. A complete batch withdraws the results of its competitions that it no longer lists.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AuditActor } from '$lib/server/audit/record';
import type { Database } from '$lib/server/db';
import { athleteLinks, candidates, sourceFacts } from '$lib/server/db/schema';
import type { JobCreator } from '$lib/server/jobs/queue';
import { loadProjectionTaxonomy, resultFact } from '../projection';
import type { ReceiptSigner } from '../receipts';
import { applyFacts, currentGrounds, type FspSyncSummary } from '../sync';
import type { Competition } from '../types';
import type { ResultsBatch } from './feed';
import type { BatchRow } from './rows';

export interface ImportOptions {
	actor: AuditActor;
	createdBy: JobCreator;
	requestId: string;
	signer: ReceiptSigner;
	/** Import the valid rows of a batch that has row issues; by default such a batch writes nothing. */
	allowRowIssues?: boolean;
}

/** Valid rows of a batch: those that reached a linked athlete under consent and why the others did not. */
interface RowCounts {
	matched: number;
	withoutFspId: number;
	notLinked: number;
	noConsent: number;
}

export interface ImportSummary {
	variant: ResultsBatch['variant'];
	profile: string;
	sha256: string;
	rowsRead: number;
	rowsValid: number;
	rowIssues: number;
	competitions: number;
	complete: boolean;
	incompleteReason: string | null;
	/** Why valid rows reached no one; none of them is stored. */
	rows: RowCounts;
	athletes: number;
	facts: Omit<FspSyncSummary, 'facts' | 'complete' | 'profileRevision'>;
}

type ImportResult =
	{ ok: true; summary: ImportSummary } | { ok: false; code: 'row_issues' | 'taxonomy_missing'; message: string };

const eventKeyOf = (competitionId: string) => `fsp:competition:${competitionId}`;

/** Active links of the named athletes, by athlete ID. */
async function linksOf(db: Database, athleteIds: readonly string[]): Promise<Map<string, string>> {
	if (athleteIds.length === 0) return new Map();
	const rows = await db
		.select({ id: athleteLinks.id, athleteId: athleteLinks.sourceAthleteId })
		.from(athleteLinks)
		.where(
			and(
				eq(athleteLinks.source, 'fsp'),
				eq(athleteLinks.status, 'active'),
				// No link of a demo session is updated by webhooks or result batches, neither a clone's nor one of an account
				// signed up within the session: such an account imports by its own consent through `fsp.sync` (domain 19.3).
				isNull(athleteLinks.demoSessionId),
				inArray(athleteLinks.sourceAthleteId, [...athleteIds])
			)
		);
	return new Map(rows.map((r) => [r.athleteId, r.id]));
}

/** Links holding active results of the batch's competitions: a complete batch speaks for them too. */
async function linksWithResultsOf(db: Database, eventKeys: readonly string[]): Promise<string[]> {
	if (eventKeys.length === 0) return [];
	const rows = await db
		.selectDistinct({ linkId: sourceFacts.ownershipRef })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.ownershipBasis, 'athlete_link'),
				eq(sourceFacts.factType, 'competition_result'),
				eq(sourceFacts.status, 'active'),
				inArray(sourceFacts.eventKey, [...eventKeys])
			)
		);
	return rows.map((r) => r.linkId).filter((id): id is string => id !== null);
}

/** Rows of a batch by the athlete link they reach; rows that reach no link are counted by the reason. */
async function routeRows(db: Database, batch: ResultsBatch) {
	const eventKeys = new Set(batch.competitions.map((c) => eventKeyOf(c.id)));
	const byAthlete = new Map<string, BatchRow[]>();
	const counts: RowCounts = { matched: 0, withoutFspId: 0, notLinked: 0, noConsent: 0 };
	for (const row of batch.rows) {
		const fspId = row.participant.fspId;
		if (fspId === undefined) {
			counts.withoutFspId++;
			continue;
		}
		byAthlete.set(fspId, [...(byAthlete.get(fspId) ?? []), row]);
	}
	const links = await linksOf(db, [...byAthlete.keys()]);
	const work = new Map<string, BatchRow[]>();
	for (const [fspId, rows] of byAthlete) {
		const linkId = links.get(fspId);
		if (linkId === undefined) counts.notLinked += rows.length;
		else work.set(linkId, rows);
	}
	if (batch.completeness.complete) {
		for (const linkId of await linksWithResultsOf(db, [...eventKeys])) {
			if (!work.has(linkId)) work.set(linkId, []);
		}
	}
	return { eventKeys, counts, work };
}

interface ImportPreview {
	/** How the valid rows would reach people now; the import checks the grounds again, athlete by athlete. */
	rows: RowCounts;
	/** Linked athletes whose results the import compares: those of the rows and, for a complete batch, those it drops. */
	athletes: number;
	/** No published taxonomy: the import would be refused. */
	taxonomyMissing: boolean;
}

/**
 * What an import of the batch would do, without writing anything: how many valid rows reach a linked athlete under
 * `fsp_import` in effect, and why the rest reach no one.
 */
export async function previewResultsBatch(db: Database, batch: ResultsBatch): Promise<ImportPreview> {
	const { counts, work } = await routeRows(db, batch);
	let athletes = 0;
	for (const [linkId, rows] of work) {
		if ((await currentGrounds(db, linkId)) === null) {
			counts.noConsent += rows.length;
			continue;
		}
		athletes++;
		counts.matched += rows.length;
	}
	return { rows: counts, athletes, taxonomyMissing: (await loadProjectionTaxonomy(db)) === null };
}

export async function importResultsBatch(
	db: Database,
	batch: ResultsBatch,
	options: ImportOptions
): Promise<ImportResult> {
	if (batch.issues.length > 0 && !options.allowRowIssues) {
		return {
			ok: false,
			code: 'row_issues',
			message: `в ${batch.issues.length} строках ошибки: исправьте файл или явно загрузите только верные строки`
		};
	}
	const taxonomy = await loadProjectionTaxonomy(db);
	if (!taxonomy) return { ok: false, code: 'taxonomy_missing', message: 'нет опубликованной версии справочников' };

	const competitions = new Map<string, Competition>(batch.competitions.map((c) => [c.id, c]));
	const { eventKeys, counts, work } = await routeRows(db, batch);

	const facts: ImportSummary['facts'] = {
		inserted: 0,
		unchanged: 0,
		superseded: 0,
		annulled: 0,
		withdrawn: 0,
		skippedWithdrawals: 0,
		claims: 0,
		receipts: 0
	};
	let athletes = 0;
	for (const [linkId, rows] of [...work.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const applied = await db.transaction(async (tx) => {
			const [owner] = await tx
				.select({ candidateId: candidates.id })
				.from(athleteLinks)
				.innerJoin(candidates, eq(candidates.userId, athleteLinks.userId))
				.where(eq(athleteLinks.id, linkId));
			if (!owner) return null;
			// Serializes with a revocation or an unlink of the same candidate, then checks the grounds (domain 17.1).
			await tx.select({ id: candidates.id }).from(candidates).where(eq(candidates.id, owner.candidateId)).for('update');
			const grounds = await currentGrounds(tx, linkId);
			if (!grounds) return null;
			const drafts = rows.map((row) => {
				const competition = competitions.get(row.competitionId);
				if (!competition) throw new Error('a batch row references a competition absent from the batch');
				return resultFact({ ...row.result, id: row.recordId, competitionId: row.competitionId }, competition);
			});
			return applyFacts(tx, {
				grounds,
				drafts,
				birthYear: rows.find((r) => r.participant.birthYear != null)?.participant.birthYear,
				sourceSnapshotSha256: batch.sha256,
				sourceVersion: batch.completeness.sourceVersion,
				coverage: { scope: 'competitions', eventKeys },
				complete: batch.completeness.complete,
				incompleteReason: batch.completeness.incompleteReason ?? null,
				variant: batch.variant,
				taxonomy,
				signer: options.signer,
				actor: options.actor,
				requestId: options.requestId,
				createdBy: options.createdBy
			});
		});
		if (applied === null) {
			counts.noConsent += rows.length;
			continue;
		}
		athletes++;
		counts.matched += rows.length;
		for (const key of Object.keys(facts) as (keyof typeof facts)[]) facts[key] += applied[key];
	}

	return {
		ok: true,
		summary: {
			variant: batch.variant,
			profile: batch.profile,
			sha256: batch.sha256,
			rowsRead: batch.rowsRead,
			rowsValid: batch.rows.length,
			rowIssues: batch.issues.length,
			competitions: batch.competitions.length,
			complete: batch.completeness.complete,
			incompleteReason: batch.completeness.incompleteReason ?? null,
			rows: counts,
			athletes,
			facts
		}
	};
}
