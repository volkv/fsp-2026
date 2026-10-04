// Publication of the legal documents of the sign-up path (`scripts/seed-legal.ts`): every kind of the registry, once;
// a changed text becomes a new version and supersedes the previous one; published versions are never edited.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishLegalDocuments, readLegalRelease, type LegalRelease } from '../../scripts/seed-legal';
import { currentDocument } from '$lib/server/auth/documents';
import { DOCUMENT_KIND_SPECS, DOCUMENT_KINDS } from '$lib/server/consent/kinds';
import { legalDocuments, pdOperators } from '$lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const LEGAL_DIR = fileURLToPath(new URL('../../legal', import.meta.url));

let database: TestDatabase;
let client: postgres.Sql;
let release: LegalRelease;

beforeAll(async () => {
	database = await createTestDatabase();
	client = postgres(database.url, { max: 1, onnotice: () => {} });
	release = await readLegalRelease(LEGAL_DIR);
});

afterAll(async () => {
	await client.end({ timeout: 5 });
	await database.drop();
});

describe('legal documents seed', () => {
	it('publishes every kind of the registry with its form and availability, then changes nothing on repeat', async () => {
		expect(release.documents.map((d) => d.kind)).toEqual([...DOCUMENT_KINDS]);
		for (const document of release.documents) {
			// Prototype editions say so, and the operator is a marked placeholder, never invented details.
			expect(document.body).toMatch(/^Редакция прототипа\./);
		}
		expect(release.operator.legal_name).toContain('[ЗАГЛУШКА]');

		const first = await publishLegalDocuments(client, release);
		expect(first.every((o) => o.outcome === 'published' && o.version === 1)).toBe(true);
		const now = new Date();
		for (const kind of DOCUMENT_KINDS) {
			const current = await currentDocument(database.db, kind, now);
			expect(current?.available).toBe(DOCUMENT_KIND_SPECS[kind].availableByDefault);
		}
		const [signature] = await database.db
			.select({ form: legalDocuments.form })
			.from(legalDocuments)
			.where(eq(legalDocuments.kind, 'automated_decision_written'));
		expect(signature?.form).toBe('electronic_signature');

		const again = await publishLegalDocuments(client, release);
		expect(again.every((o) => o.outcome === 'unchanged' && o.version === 1)).toBe(true);
		expect(await database.db.select().from(pdOperators)).toHaveLength(1);
	});

	it('publishes a changed text as the next version and supersedes the previous one', async () => {
		const changed: LegalRelease = {
			...release,
			documents: release.documents.map((d) => {
				if (d.kind !== 'pd_processing') return d;
				const body = `${d.body}\n\nДополнение.`;
				return { ...d, body, bodySha256: createHash('sha256').update(body, 'utf8').digest('hex') };
			})
		};
		const outcomes = await publishLegalDocuments(client, changed);
		expect(outcomes.filter((o) => o.outcome === 'published')).toEqual([
			{ kind: 'pd_processing', version: 2, outcome: 'published' }
		]);
		const live = await database.db
			.select({ version: legalDocuments.version })
			.from(legalDocuments)
			.where(and(eq(legalDocuments.kind, 'pd_processing'), isNull(legalDocuments.supersededAt)));
		expect(live).toEqual([{ version: 2 }]);
		expect((await currentDocument(database.db, 'pd_processing', new Date()))?.version).toBe(2);
	});
});
