// Publication of the legal documents of the sign-up path (`scripts/seed-legal.ts`): every kind of the registry, once;
// a changed text becomes a new version and supersedes the previous one; published versions are never edited. A new
// recipient of the data asks for consent again; a corrected wording does not.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishLegalDocuments, readLegalRelease, type LegalRelease } from '../../scripts/seed-legal';
import { currentDocument } from '$lib/server/auth/documents';
import { DOCUMENT_KIND_SPECS, DOCUMENT_KINDS, type DocumentKind } from '$lib/server/consent/kinds';
import { processingAllowed } from '$lib/server/consent/processing';
import { consentEvents, legalDocuments, pdOperators } from '$lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate } from '../helpers/factories';

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

	it('asks for consent again when the processors change, and not when only the wording does', async () => {
		const { db } = database;
		const candidate = await createCandidate(db, {}, { processingConsent: false });
		const sign = async () => {
			const document = await currentDocument(db, 'pd_processing', new Date());
			await db.insert(consentEvents).values({
				subjectCandidateId: candidate.id,
				kind: 'pd_processing',
				documentId: document?.id ?? '',
				action: 'grant',
				signerKind: 'subject',
				signerUserId: candidate.userId,
				method: 'separate_screen_button',
				evidence: {},
				occurredAt: new Date()
			});
		};
		await sign();
		expect(await processingAllowed(db, candidate.id, new Date())).toBe(true);

		const otherModel = withProcessors(release, 'Другой поставщик модели');
		const outcomes = await publishLegalDocuments(client, otherModel);
		expect(outcomes.every((o) => o.outcome === 'published')).toBe(true);
		expect(await reconsentKinds()).toEqual(['catalog_visibility', 'demo_resume_upload', 'pd_processing']);
		// The grant names the former recipient: the data are not processed until the candidate signs the new text.
		expect(await processingAllowed(db, candidate.id, new Date())).toBe(false);
		await sign();
		expect(await processingAllowed(db, candidate.id, new Date())).toBe(true);

		const corrected = await publishLegalDocuments(client, withBody(otherModel, 'pd_processing', 'Исправление.'));
		expect(corrected.filter((o) => o.outcome === 'published').map((o) => o.kind)).toEqual(['pd_processing']);
		expect(await reconsentKinds()).toEqual(['catalog_visibility', 'demo_resume_upload']);
		expect(await processingAllowed(db, candidate.id, new Date())).toBe(true);
		const again = await publishLegalDocuments(client, withBody(otherModel, 'pd_processing', 'Исправление.'));
		expect(again.every((o) => o.outcome === 'unchanged')).toBe(true);
	});

	it('asks for consent again when the processors changed in a version published without asking', async () => {
		const thirdModel = withProcessors(release, 'Третий поставщик модели');
		const silent: LegalRelease = {
			...thirdModel,
			documents: thirdModel.documents.map((d) => ({ ...d, coversProcessors: false }))
		};
		await publishLegalDocuments(client, silent);
		expect(await reconsentKinds()).toEqual(['catalog_visibility']);

		const outcomes = await publishLegalDocuments(client, thirdModel);
		expect(outcomes.filter((o) => o.outcome === 'published').map((o) => o.kind)).toEqual([
			'pd_processing',
			'demo_resume_upload'
		]);
		expect(await reconsentKinds()).toEqual(['catalog_visibility', 'demo_resume_upload', 'pd_processing']);
		const again = await publishLegalDocuments(client, thirdModel);
		expect(again.every((o) => o.outcome === 'unchanged')).toBe(true);
	});
});

/** The release with the language model of the processors replaced by `name`. */
function withProcessors(base: LegalRelease, name: string): LegalRelease {
	const processors = base.processors.map((p) => (p.role.startsWith('языковая модель') ? { ...p, name } : p));
	expect(processors).not.toEqual(base.processors);
	return { ...base, processors };
}

function withBody(base: LegalRelease, kind: DocumentKind, addition: string): LegalRelease {
	return {
		...base,
		documents: base.documents.map((d) => {
			if (d.kind !== kind) return d;
			const body = `${d.body}\n\n${addition}`;
			return { ...d, body, bodySha256: createHash('sha256').update(body, 'utf8').digest('hex') };
		})
	};
}

/** The kinds whose current version asks for consent again. */
async function reconsentKinds(): Promise<string[]> {
	const rows = await database.db
		.select({ kind: legalDocuments.kind })
		.from(legalDocuments)
		.where(and(isNull(legalDocuments.supersededAt), eq(legalDocuments.requiresReconsent, true)));
	return rows.map((r) => r.kind).sort();
}
