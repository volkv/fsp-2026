// Legal documents shown on the sign-up path (domain 6.2): the current published version of a kind.
import { and, desc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import type { DocumentKind } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import { legalDocuments } from '$lib/server/db/schema';

export interface CurrentDocument {
	id: string;
	kind: DocumentKind;
	version: number;
	title: string;
	body: string;
	bodySha256: string;
	available: boolean;
}

const columns = {
	id: legalDocuments.id,
	kind: legalDocuments.kind,
	version: legalDocuments.version,
	title: legalDocuments.title,
	body: legalDocuments.body,
	bodySha256: legalDocuments.bodySha256,
	available: legalDocuments.available
};

/** The newest published, not superseded version of the kind; `null` when none is published. */
export async function currentDocument(
	executor: Executor,
	kind: DocumentKind,
	now: Date
): Promise<CurrentDocument | null> {
	const [row] = await executor
		.select(columns)
		.from(legalDocuments)
		.where(
			and(
				eq(legalDocuments.kind, kind),
				isNotNull(legalDocuments.publishedAt),
				lte(legalDocuments.publishedAt, now),
				isNull(legalDocuments.supersededAt)
			)
		)
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	return row ?? null;
}

/**
 * The document a form showed, if it is still the current version of its kind. A version published between showing
 * and submitting makes the person read the new text: an acceptance names the exact version.
 */
export async function stillCurrent(
	executor: Executor,
	kind: DocumentKind,
	documentId: string,
	now: Date
): Promise<CurrentDocument | null> {
	const current = await currentDocument(executor, kind, now);
	return current?.id === documentId ? current : null;
}
