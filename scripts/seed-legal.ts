// Publishes the legal documents from `legal/` into the database from DATABASE_URL (docs/domain.md, section 6.2). Runs
// with plain Node (type stripping), without the SvelteKit runtime. A kind whose text or properties changed gets a new
// version and the previous one is marked superseded; repeating it with unchanged files is a no-op.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { z } from 'zod';
import { DOCUMENT_KIND_SPECS, DOCUMENT_KINDS, type DocumentKind } from '../src/lib/server/consent/kinds.ts';
import { uuidv7 } from '../src/lib/server/ids.ts';

const code = z.string().regex(/^[a-z][a-z0-9_]*$/);
const manifestSchema = z.strictObject({
	operator: z.strictObject({
		legal_name: z.string().min(1),
		inn: z.string().min(1),
		ogrn: z.string().min(1),
		address: z.string().min(1),
		contact_email: z.string().min(1),
		valid_from: z.iso.date()
	}),
	processors: z.array(z.strictObject({ role: z.string().min(1), name: z.string().min(1) })),
	documents: z.record(
		z.enum(DOCUMENT_KINDS),
		z.strictObject({
			title: z.string().min(1),
			purposes: z.array(code).min(1),
			data_categories: z.array(code).min(1),
			operations: z.array(code).min(1),
			requires_reconsent: z.boolean()
		})
	)
});

export interface LegalDocument {
	kind: DocumentKind;
	title: string;
	body: string;
	bodySha256: string;
	purposes: string[];
	dataCategories: string[];
	operations: string[];
	form: 'electronic_separate_screen' | 'electronic_signature';
	available: boolean;
	requiresReconsent: boolean;
}

export interface LegalRelease {
	operator: z.infer<typeof manifestSchema>['operator'];
	processors: z.infer<typeof manifestSchema>['processors'];
	documents: LegalDocument[];
}

/** Reads `documents.json` and one `<kind>.md` per kind of the registry; a kind without its text is an error. */
export async function readLegalRelease(directory: string): Promise<LegalRelease> {
	const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'documents.json'), 'utf8')));
	const documents: LegalDocument[] = [];
	for (const kind of DOCUMENT_KINDS) {
		// The record schema has the kinds as its keys: an entry missing from the manifest fails the parse above.
		const entry = manifest.documents[kind];
		const body = (await readFile(join(directory, `${kind}.md`), 'utf8')).trim();
		if (body === '') throw new Error(`legal/${kind}.md is empty`);
		const spec = DOCUMENT_KIND_SPECS[kind];
		documents.push({
			kind,
			title: entry.title,
			body,
			bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
			purposes: entry.purposes,
			dataCategories: entry.data_categories,
			operations: entry.operations,
			form: spec.form,
			available: spec.availableByDefault,
			requiresReconsent: entry.requires_reconsent
		});
	}
	return { operator: manifest.operator, processors: manifest.processors, documents };
}

export interface PublishedKind {
	kind: DocumentKind;
	version: number;
	outcome: 'published' | 'unchanged';
}

interface CurrentRow {
	id: string;
	version: number;
	title: string;
	body_sha256: string;
	pd_operator_id: string;
	/** Compared in the database: jsonb keeps its own key order. */
	same_processors: boolean;
	purposes: string[];
	data_categories: string[];
	operations: string[];
	form: string;
	available: boolean;
	requires_reconsent: boolean;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function unchanged(row: CurrentRow, document: LegalDocument, operatorId: string): boolean {
	return (
		row.title === document.title &&
		row.body_sha256 === document.bodySha256 &&
		row.pd_operator_id === operatorId &&
		row.same_processors &&
		sameList(row.purposes, document.purposes) &&
		sameList(row.data_categories, document.dataCategories) &&
		sameList(row.operations, document.operations) &&
		row.form === document.form &&
		row.available === document.available &&
		row.requires_reconsent === document.requiresReconsent
	);
}

/** Publishes the release in one transaction under an advisory lock; concurrent starts publish once. */
export async function publishLegalDocuments(client: postgres.Sql, release: LegalRelease): Promise<PublishedKind[]> {
	return client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended('legal.publish', 0))`;
		const operator = release.operator;
		const [found] = await tx<{ id: string }[]>`
			select id from pd_operators
			where legal_name = ${operator.legal_name} and inn = ${operator.inn} and ogrn = ${operator.ogrn}
				and address = ${operator.address} and contact_email = ${operator.contact_email}
				and valid_from = ${operator.valid_from} and valid_to is null`;
		const operatorId = found?.id ?? uuidv7();
		if (!found) {
			await tx`
				insert into pd_operators (id, legal_name, inn, ogrn, address, contact_email, valid_from)
				values (${operatorId}, ${operator.legal_name}, ${operator.inn}, ${operator.ogrn}, ${operator.address},
					${operator.contact_email}, ${operator.valid_from})`;
		}

		const outcomes: PublishedKind[] = [];
		for (const document of release.documents) {
			const [current] = await tx<CurrentRow[]>`
				select id, version, title, body_sha256, pd_operator_id,
					processors_snapshot = ${tx.json(release.processors)} as same_processors, purposes, data_categories,
					operations, form, available, requires_reconsent
				from legal_documents
				where kind = ${document.kind} and published_at is not null and superseded_at is null
				order by version desc
				limit 1`;
			if (current && unchanged(current, document, operatorId)) {
				outcomes.push({ kind: document.kind, version: current.version, outcome: 'unchanged' });
				continue;
			}
			const [latest] = await tx<{ version: number }[]>`
				select coalesce(max(version), 0)::int as version from legal_documents where kind = ${document.kind}`;
			const version = (latest?.version ?? 0) + 1;
			if (current) await tx`update legal_documents set superseded_at = now() where id = ${current.id}`;
			await tx`
				insert into legal_documents (id, kind, version, title, body, body_sha256, pd_operator_id, operator_snapshot,
					processors_snapshot, purposes, data_categories, operations, form, available, requires_reconsent,
					published_at)
				values (${uuidv7()}, ${document.kind}, ${version}, ${document.title}, ${document.body}, ${document.bodySha256},
					${operatorId}, ${tx.json(operator)}, ${tx.json(release.processors)}, ${document.purposes},
					${document.dataCategories}, ${document.operations}, ${document.form}, ${document.available},
					${document.requiresReconsent}, now())`;
			outcomes.push({ kind: document.kind, version, outcome: 'published' });
		}
		return outcomes;
	});
}

if (import.meta.main) {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('DATABASE_URL is not set');
	const release = await readLegalRelease(fileURLToPath(new URL('../legal', import.meta.url)));
	const client = postgres(databaseUrl, {
		max: 1,
		onnotice: (notice) => {
			console.log(`[seed-legal] ${notice.severity}: ${notice.message}`);
		}
	});
	try {
		const outcomes = await publishLegalDocuments(client, release);
		console.log(`Legal documents: ${outcomes.map((o) => `${o.kind} v${o.version} ${o.outcome}`).join(', ')}`);
	} finally {
		await client.end({ timeout: 5 });
	}
}
