// FSP results batches (docs/contracts.md 1.7): an export in CSV and XLSX and PDF protocols read by the real parser image,
// mapped by a profile into the facts of the API variant. Rows reach a candidate only through the FSP athlete ID and an
// active link under the `fsp_import` consent — never by name; row issues are reported by row, column and reason;
// a repeated batch changes nothing; a complete batch withdraws, an incomplete one does not; a new protocol edition
// supersedes the previous one.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	claims,
	consentEvents,
	demoSessions,
	externalIdentities,
	sourceFacts,
	verificationReceipts
} from '$lib/server/db/schema';
import { DocparseClient } from '$lib/server/documents/docparse';
import { importResultsBatch, type ImportOptions } from '$lib/server/fsp/import/apply';
import { feedFor, type ResultsBatch } from '$lib/server/fsp/import/feed';
import { parseProfile, type MappingProfile } from '$lib/server/fsp/import/profile';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createPublishedDocument, createUser, randomSha256 } from '../helpers/factories';

const FIXTURES = fileURLToPath(new URL('../fixtures/fsp-import', import.meta.url));
const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DOCPARSE_DIR = fileURLToPath(new URL('../../services/docparse', import.meta.url));
const DOCPARSE_IMAGE = 'fsp-docparse:test';
const ISSUER = 'http://fsp-id.test';

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 4)
});

class ParserContainer extends GenericContainer {
	constructor() {
		super(DOCPARSE_IMAGE);
		this.withExposedPorts(8000)
			.withTmpFs({ '/tmp': 'size=512m,mode=1777' })
			.withDroppedCapabilities('ALL')
			.withSecurityOpt('no-new-privileges:true')
			.withResourcesQuota({ memory: 0.75, cpu: 2 })
			.withWaitStrategy(Wait.forHttp('/v1/health', 8000))
			.withStartupTimeout(60_000);
		this.hostConfig.ReadonlyRootfs = true;
	}
}

let database: TestDatabase;
let parser: StartedTestContainer;
let docparse: DocparseClient;

const options: ImportOptions = {
	actor: { kind: 'system' },
	createdBy: { kind: 'system' },
	requestId: 'test-fsp-import',
	signer: createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) })
};

beforeAll(async () => {
	const build = promisify(execFile)(
		'docker',
		['build', '--quiet', '--target', 'runtime', '--tag', DOCPARSE_IMAGE, DOCPARSE_DIR],
		{ maxBuffer: 16 * 1024 * 1024 }
	).then(() => new ParserContainer().start());
	const [started, created] = await Promise.all([build, createTestDatabase()]);
	parser = started;
	database = created;
	docparse = new DocparseClient(`http://${parser.getHost()}:${parser.getMappedPort(8000)}`, 2);
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
}, 900_000);

afterAll(async () => {
	await parser.stop();
	await database.drop();
});

// --- Helpers ------------------------------------------------------------------------------------------------------

function fixture(name: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(readFileSync(`${FIXTURES}/${name}`));
}

function profile(name: string): MappingProfile {
	const parsed = parseProfile(JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8')));
	if (!parsed.ok) throw new Error(parsed.issues.join('; '));
	return parsed.profile;
}

async function read(
	bytes: Uint8Array<ArrayBuffer>,
	profileName: string,
	declaredComplete: boolean
): Promise<ResultsBatch> {
	const result = await feedFor(bytes, () => docparse).readBatch({
		bytes,
		declaredName: 'batch',
		profile: profile(profileName),
		declaredComplete,
		requestId: 'test-fsp-import'
	});
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

async function importBatch(batch: ResultsBatch, extra: Partial<ImportOptions> = {}) {
	const result = await importResultsBatch(database.db, batch, { ...options, ...extra });
	if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
	return result.summary;
}

interface Athlete {
	fspId: string;
	candidateId: string;
	linkId: string;
}

/** Every athlete linked so far, by FSP ID: lets a later describe reach one linked by an earlier one. */
const athletesByFspId = new Map<string, Athlete>();

function athleteOf(fspId: string): Athlete {
	const athlete = athletesByFspId.get(fspId);
	if (!athlete) throw new Error(`no athlete linked for ${fspId}`);
	return athlete;
}

/**
 * A candidate who signed in with FSP ID as `fspId`, with an active athlete link and, unless told, `fsp_import`. The
 * birth date agrees with the year the batch gives: a disagreeing one is an age conflict, and consent needs the age.
 * With `demoSession` — the clone of such a candidate in that demo session, its link active within the session.
 */
async function linkAthlete(
	fspId: string,
	input: { birthYear?: number; consent?: boolean; lastName?: string; demoSession?: string } = {}
): Promise<Athlete> {
	const { db } = database;
	const demoSession = input.demoSession ?? null;
	const user = await createUser(db, { demoSessionId: demoSession });
	const candidate = await createCandidate(db, {
		userId: user.id,
		demoSessionId: demoSession,
		birthDate: `${input.birthYear ?? 1998}-06-15`,
		...(input.lastName ? { lastNameEnc: crypto.encrypt(input.lastName, 'candidates.last_name') } : {})
	});
	const [identity] = await db
		.insert(externalIdentities)
		.values({
			userId: candidate.userId,
			issuer: ISSUER,
			subject: fspId,
			linkedAt: new Date(),
			linkMethod: 'signup_via_provider',
			demoSessionId: demoSession
		})
		.returning();
	if (!identity) throw new Error('identity not inserted');
	const [link] = await db
		.insert(athleteLinks)
		.values({
			userId: candidate.userId,
			source: 'fsp',
			sourceAthleteId: fspId,
			basisIdentityId: identity.id,
			resolutionMethod: 'subject_equals_athlete_id',
			status: 'active',
			linkedAt: new Date(),
			demoSessionId: demoSession
		})
		.returning();
	if (!link) throw new Error('link not inserted');
	if (input.consent !== false) {
		const document = await createPublishedDocument(db, 'fsp_import');
		await db.insert(consentEvents).values({
			subjectCandidateId: candidate.id,
			kind: 'fsp_import',
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			method: 'separate_screen_button',
			evidence: { document_sha256: document.bodySha256 },
			occurredAt: new Date(Date.now() - 60_000)
		});
	}
	const athlete: Athlete = { fspId, candidateId: candidate.id, linkId: link.id };
	if (demoSession === null) athletesByFspId.set(fspId, athlete);
	return athlete;
}

function factsOf(candidateId: string) {
	return database.db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, candidateId)).orderBy(sourceFacts.id);
}

async function activeRefs(candidateId: string): Promise<string[]> {
	const rows = await factsOf(candidateId);
	return rows
		.filter((f) => f.status === 'active')
		.map((f) => f.sourceRecordRef)
		.sort();
}

async function allFactCount(): Promise<number> {
	return (await database.db.select({ id: sourceFacts.id }).from(sourceFacts)).length;
}

/** The CSV export without the lines naming `fspId` in the competition with `ekp`. */
function exportWithout(fspId: string, ekp: string): Uint8Array<ArrayBuffer> {
	const text = readFileSync(`${FIXTURES}/results.csv`, 'utf8');
	const kept = text.split('\n').filter((line) => !(line.startsWith(`${fspId};`) && line.includes(`;${ekp};`)));
	return new Uint8Array(Buffer.from(kept.join('\n'), 'utf8'));
}

const C1 = '2101770020099901';
const C2 = '2101770020099902';
const ref = (competition: string, fspId: string) => `fsp:result:ekp:${competition}:${fspId}`;

// --- Export (CSV, XLSX) -----------------------------------------------------------------------------------------

describe('an export file', () => {
	let first: Athlete;
	let second: Athlete;
	let withoutConsent: Athlete;
	let namesake: Athlete;
	let clone: Athlete;

	beforeAll(async () => {
		first = await linkAthlete('FSP-000101', { birthYear: 2004 });
		second = await linkAthlete('FSP-000102', { birthYear: 2006 });
		withoutConsent = await linkAthlete('FSP-000103', { birthYear: 2005, consent: false });
		// Carries the surname of the CSV row without an FSP ID and is linked to another athlete.
		namesake = await linkAthlete('FSP-000500', { lastName: 'Тестов' });
		// The clone of the first athlete in a demo session: its link is active within the session only.
		const [session] = await database.db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + 86_400_000) })
			.returning();
		if (!session) throw new Error('demo session not inserted');
		clone = await linkAthlete('FSP-000101', { birthYear: 2004, demoSession: session.id });
	});

	it('imports the rows of linked athletes with consent and only those, as verified facts with claims and receipts', async () => {
		const batch = await read(fixture('results.csv'), 'profile.json', true);
		expect(batch.format).toBe('csv');
		expect(batch.issues).toEqual([]);
		expect(batch.completeness).toMatchObject({ complete: true, scope: 'competition' });
		expect(batch.competitions.map((c) => c.id).sort()).toEqual([`ekp:${C1}`, `ekp:${C2}`]);

		const summary = await importBatch(batch);
		expect(summary.rowsRead).toBe(7);
		expect(summary.rows).toEqual({ matched: 4, withoutFspId: 1, notLinked: 1, noConsent: 1 });
		expect(summary.athletes).toBe(2);
		expect(summary.facts).toMatchObject({ inserted: 4, unchanged: 0, withdrawn: 0 });
		expect(summary.facts.claims).toBeGreaterThan(0);
		expect(summary.facts.receipts).toBe(4);

		expect(await activeRefs(first.candidateId)).toEqual([ref(C1, 'FSP-000101'), ref(C2, 'FSP-000101')]);
		expect(await activeRefs(second.candidateId)).toEqual([ref(C1, 'FSP-000102'), ref(C2, 'FSP-000102')]);
		const facts = await factsOf(first.candidateId);
		for (const fact of facts) {
			expect(fact).toMatchObject({
				source: 'fsp',
				factType: 'competition_result',
				trustLevel: 'fsp_verified',
				ownershipBasis: 'athlete_link',
				ownershipRef: first.linkId,
				sourceSnapshotSha256: batch.sha256
			});
		}
		const team = facts.find((f) => f.sourceRecordRef === ref(C2, 'FSP-000101'));
		expect(team?.payload).toMatchObject({
			result: { place: 1, status: 'official', team: { name: 'Синтетика', role: 'captain' } },
			competition: { discipline: 'product', level: 'russian_championship', stage: 'final', online: false }
		});
		const factIds = facts.map((f) => f.id);
		expect(
			await database.db.select().from(verificationReceipts).where(inArray(verificationReceipts.factId, factIds))
		).toHaveLength(2);
		expect(
			await database.db
				.select()
				.from(claims)
				.where(and(inArray(claims.factId, factIds), eq(claims.status, 'active')))
		).not.toHaveLength(0);

		// Linked without consent: nothing of the row is stored.
		expect(await factsOf(withoutConsent.candidateId)).toEqual([]);
		// A clone of a demo session is never synchronized: the batch reaches the original only.
		expect(await factsOf(clone.candidateId)).toEqual([]);
	});

	it('never ties a row to a person by name: a row without the FSP ID reaches no one', async () => {
		expect(await factsOf(namesake.candidateId)).toEqual([]);
		const rows = await database.db.select({ ref: sourceFacts.sourceRecordRef }).from(sourceFacts);
		expect(rows.filter((r) => r.ref.includes(':row:'))).toEqual([]);
		// Every stored fact belongs to the link of the FSP ID its row names.
		const stored = await database.db
			.select({ ref: sourceFacts.sourceRecordRef, athlete: athleteLinks.sourceAthleteId })
			.from(sourceFacts)
			.innerJoin(athleteLinks, eq(athleteLinks.id, sourceFacts.ownershipRef));
		for (const fact of stored) expect(fact.ref.endsWith(`:${fact.athlete}`)).toBe(true);
	});

	it('changes nothing when the same export comes again', async () => {
		const before = await allFactCount();
		const summary = await importBatch(await read(fixture('results.csv'), 'profile.json', true));
		expect(summary.facts).toMatchObject({ inserted: 0, unchanged: 4, superseded: 0, withdrawn: 0, receipts: 0 });
		expect(await allFactCount()).toBe(before);
	});

	it('reads the XLSX of the same export into the same rows, so its import is the same facts', async () => {
		const csv = await read(fixture('results.csv'), 'profile.json', true);
		const xlsx = await read(fixture('results.xlsx'), 'profile.json', true);
		expect(xlsx.format).toBe('xlsx');
		expect(xlsx.issues).toEqual([]);
		expect(xlsx.competitions).toEqual(csv.competitions);
		const strip = (b: ResultsBatch) => b.rows.map((r) => ({ ...r, recordId: r.recordId.replace(b.sha256, '') }));
		expect(strip(xlsx)).toEqual(strip(csv));
		const summary = await importBatch(xlsx);
		expect(summary.facts).toMatchObject({ inserted: 0, unchanged: 4, superseded: 0, withdrawn: 0 });
	});

	it('reports every bad row by row, column and reason and writes nothing unless told to import the rest', async () => {
		const batch = await read(fixture('results-errors.csv'), 'profile.json', true);
		expect(batch.issues.map(({ row, column, code }) => ({ row, column, code }))).toEqual([
			{ row: 3, column: 'Место', code: 'invalid_number' },
			{ row: 4, column: 'Дата начала', code: 'invalid_date' },
			{ row: 5, column: 'Статус результата', code: 'unknown_value' },
			{ row: 6, column: null, code: 'duplicate_result' },
			{ row: 7, column: 'ФСП ID', code: 'no_participant' }
		]);
		expect(batch.rowsRead).toBe(7);
		expect(batch.rows).toHaveLength(2);
		// Messages carry no data of a person from the cells.
		for (const issue of batch.issues) expect(issue.message).not.toMatch(/Образцов|Примерова|Макетов|Пробный/);
		expect(batch.completeness).toMatchObject({ complete: false, incompleteReason: 'row_issues' });

		const before = await allFactCount();
		const refused = await importResultsBatch(database.db, batch, options);
		expect(refused).toMatchObject({ ok: false, code: 'row_issues' });
		expect(await allFactCount()).toBe(before);

		// The valid rows alone: unchanged facts, and no withdrawal from a batch that is not complete.
		const summary = await importBatch(batch, { allowRowIssues: true });
		expect(summary.rows).toEqual({ matched: 1, withoutFspId: 0, notLinked: 1, noConsent: 0 });
		expect(summary.facts).toMatchObject({ inserted: 0, unchanged: 1, withdrawn: 0, skippedWithdrawals: 0 });
		expect(await activeRefs(second.candidateId)).toEqual([ref(C1, 'FSP-000102'), ref(C2, 'FSP-000102')]);
	});

	it('withdraws a result the competition no longer lists only from an export declared complete', async () => {
		const bytes = exportWithout('FSP-000102', C1);
		const partial = await importBatch(await read(bytes, 'profile.json', false));
		expect(partial.complete).toBe(false);
		expect(partial.facts).toMatchObject({ withdrawn: 0, skippedWithdrawals: 1 });
		expect(await activeRefs(second.candidateId)).toEqual([ref(C1, 'FSP-000102'), ref(C2, 'FSP-000102')]);

		const complete = await importBatch(await read(bytes, 'profile.json', true));
		expect(complete.complete).toBe(true);
		expect(complete.facts).toMatchObject({ withdrawn: 1, skippedWithdrawals: 0 });
		expect(await activeRefs(second.candidateId)).toEqual([ref(C2, 'FSP-000102')]);
		const [withdrawn] = (await factsOf(second.candidateId)).filter((f) => f.status === 'withdrawn');
		expect(withdrawn).toMatchObject({
			sourceRecordRef: ref(C1, 'FSP-000102'),
			statusReason: 'absent_from_complete_batch'
		});
		// The first athlete's results of the same competitions stay as they were.
		expect(await activeRefs(first.candidateId)).toEqual([ref(C1, 'FSP-000101'), ref(C2, 'FSP-000101')]);
	});

	it('refuses a profile whose columns the file does not have', async () => {
		const wrong = { ...profile('profile.json'), columns: { fspId: 'Номер спортсмена' } };
		const bytes = fixture('results.csv');
		const result = await feedFor(bytes, () => docparse).readBatch({
			bytes,
			declaredName: 'batch',
			profile: wrong,
			declaredComplete: true,
			requestId: 'test-fsp-import'
		});
		expect(result).toMatchObject({ ok: false, error: { code: 'mapping_required', retryable: false } });
	});
});

// --- PDF protocols ------------------------------------------------------------------------------------------------

describe('a PDF protocol', () => {
	const EKP = '2101770020099903';
	let second: Athlete;

	beforeAll(async () => {
		// The protocol also names FSP-000101 and FSP-000102, linked with consent for the export above.
		second = await linkAthlete('FSP-000301');
	});

	it('reads the table of results and the heading of a text protocol through the parser', async () => {
		const batch = await read(fixture('protocol.pdf'), 'protocol-profile.json', false);
		expect(batch.format).toBe('pdf');
		expect(batch.issues).toEqual([]);
		expect(batch.rowsRead).toBe(6);
		expect(batch.completeness).toMatchObject({ complete: true, scope: 'competition' });
		expect(batch.competitions).toEqual([
			expect.objectContaining({
				id: `ekp:${EKP}`,
				ekpNumber: EKP,
				discipline: 'algorithmic',
				level: 'russian_cup',
				stage: 'qualifier',
				ageGroup: 'adults',
				startDate: '2026-04-24',
				endDate: '2026-04-26',
				online: true
			})
		]);
		expect(batch.rows.map((r) => [r.rowNumber, r.participant.fspId ?? null, r.result.place])).toEqual([
			[1, 'FSP-000101', 1],
			[2, 'FSP-000301', 2],
			[3, null, 3],
			[4, 'FSP-000102', 4],
			[5, 'FSP-000302', 5],
			[6, 'FSP-000303', 6]
		]);
		expect(batch.rows[0]?.recordId).toBe(`pdf:${batch.sha256}:1`);
	});

	it('imports the rows of linked athletes, idempotently, and a new edition supersedes or withdraws the old rows', async () => {
		const v1 = await read(fixture('protocol.pdf'), 'protocol-profile.json', false);
		const summary = await importBatch(v1);
		// FSP-000101, FSP-000301, FSP-000102 are linked with consent; FSP-000302/303 are not; row 3 has no ID.
		expect(summary.rows).toEqual({ matched: 3, withoutFspId: 1, notLinked: 2, noConsent: 0 });
		expect(summary.facts).toMatchObject({ inserted: 3, withdrawn: 0 });
		expect(await activeRefs(second.candidateId)).toEqual([`fsp:result:pdf:${v1.sha256}:2`]);

		const again = await importBatch(await read(fixture('protocol.pdf'), 'protocol-profile.json', false));
		expect(again.facts).toMatchObject({ inserted: 0, unchanged: 3, superseded: 0, withdrawn: 0 });

		// Edition 2 drops FSP-000102 and corrects the penalty of FSP-000101.
		const v2 = await read(fixture('protocol-v2.pdf'), 'protocol-profile.json', false);
		expect(v2.issues).toEqual([]);
		const edition = await importBatch(v2);
		expect(edition.facts).toMatchObject({ inserted: 2, superseded: 2, withdrawn: 1 });
		expect(await activeRefs(second.candidateId)).toEqual([`fsp:result:pdf:${v2.sha256}:2`]);
		const statuses = (await factsOf(second.candidateId)).map((f) => [f.sourceRecordRef, f.status]);
		expect(statuses).toContainEqual([`fsp:result:pdf:${v1.sha256}:2`, 'superseded']);
		const pdfFacts = await database.db
			.select({ ref: sourceFacts.sourceRecordRef, status: sourceFacts.status, reason: sourceFacts.statusReason })
			.from(sourceFacts)
			.where(eq(sourceFacts.eventKey, `fsp:competition:ekp:${EKP}`));
		expect(pdfFacts).toContainEqual({
			ref: `fsp:result:pdf:${v1.sha256}:4`,
			status: 'withdrawn',
			reason: 'absent_from_complete_batch'
		});
	});
});

// --- DOCX protocols -------------------------------------------------------------------------------------------------

describe('a DOCX protocol', () => {
	const EKP = '2101770020099903';

	it('reads the same protocol as its PDF edition through the parser', async () => {
		const batch = await read(fixture('protocol.docx'), 'protocol-profile.json', false);
		expect(batch.format).toBe('docx');
		expect(batch.issues).toEqual([]);
		expect(batch.rowsRead).toBe(6);
		expect(batch.completeness).toMatchObject({ complete: true, scope: 'competition' });
		expect(batch.competitions).toEqual([
			expect.objectContaining({
				id: `ekp:${EKP}`,
				ekpNumber: EKP,
				discipline: 'algorithmic',
				level: 'russian_cup',
				stage: 'qualifier',
				ageGroup: 'adults',
				startDate: '2026-04-24',
				endDate: '2026-04-26',
				online: true
			})
		]);
		expect(batch.rows.map((r) => [r.rowNumber, r.participant.fspId ?? null, r.result.place])).toEqual([
			[1, 'FSP-000101', 1],
			[2, 'FSP-000301', 2],
			[3, null, 3],
			[4, 'FSP-000102', 4],
			[5, 'FSP-000302', 5],
			[6, 'FSP-000303', 6]
		]);
		expect(batch.rows[0]?.recordId).toBe(`pdf:${batch.sha256}:1`);
	});

	it('imports the batch as a further edition of the same protocol, idempotently, over the PDF one above', async () => {
		const docx = await read(fixture('protocol.docx'), 'protocol-profile.json', false);
		const summary = await importBatch(docx);
		// Same athletes as the PDF editions above: FSP-000101, FSP-000301, FSP-000102 linked with consent, FSP-000302/303
		// not linked, row 3 without an FSP ID.
		expect(summary.rows).toEqual({ matched: 3, withoutFspId: 1, notLinked: 2, noConsent: 0 });
		// FSP-000101 and FSP-000301 were active from the PDF edition 2 above: this edition supersedes them; FSP-000102
		// was withdrawn by edition 2 and comes back as a new record.
		expect(summary.facts).toMatchObject({ inserted: 3, superseded: 2, withdrawn: 0 });
		expect(await activeRefs(athleteOf('FSP-000301').candidateId)).toEqual([`fsp:result:pdf:${docx.sha256}:2`]);
		expect(await activeRefs(athleteOf('FSP-000102').candidateId)).toEqual(
			expect.arrayContaining([`fsp:result:pdf:${docx.sha256}:4`])
		);

		const again = await importBatch(await read(fixture('protocol.docx'), 'protocol-profile.json', false));
		expect(again.facts).toMatchObject({ inserted: 0, unchanged: 3, superseded: 0, withdrawn: 0 });
	});
});

// --- Protocols in the formats of the federation: ruled tables over several pages ----------------------------------

describe('a PDF protocol with its table over several pages', () => {
	it('reads a team protocol whose table goes on to the next page', async () => {
		const batch = await read(fixture('protocol-teams.pdf'), 'protocol-teams-profile.json', false);
		expect(batch.issues).toEqual([]);
		expect(batch.rowsRead).toBe(46);
		expect(batch.competitions).toEqual([
			expect.objectContaining({
				ekpNumber: '2101770020099904',
				discipline: 'product',
				level: 'russian_cup',
				stage: 'qualifier',
				format: 'team',
				startDate: '2026-04-21',
				endDate: '2026-04-28'
			})
		]);
		expect(batch.rows.map((r) => r.result.place)).toEqual(Array.from({ length: 46 }, (_, i) => i + 1));
		expect(batch.rows.map((r) => r.result.score)).toEqual(
			Array.from({ length: 46 }, (_, i) => (i + 1 === 12 ? 323 : Math.max(400 - (i + 1) * 7, 0)))
		);
		// The rows of the second page follow the first without a header of their own.
		expect(batch.rows.filter((r) => r.page === 2).map((r) => r.result.place)).toEqual(
			Array.from({ length: 17 }, (_, i) => i + 30)
		);
		// A long team name wraps onto two lines of its cell.
		expect(batch.rows[20]?.result.team?.name).toBe(
			'Сборная учебного университета примеров имени вымышленного деятеля науки'
		);
		expect(batch.rows.every((r) => r.participant.fspId === undefined)).toBe(true);
	});

	it('reads an individual protocol with a grid of tasks, its header repeated and a row broken across a page', async () => {
		const batch = await read(fixture('protocol-tasks.pdf'), 'protocol-tasks-profile.json', false);
		expect(batch.issues).toEqual([]);
		expect(batch.rowsRead).toBe(64);
		expect(batch.competitions).toEqual([
			expect.objectContaining({ ekpNumber: '2101770020099905', discipline: 'algorithmic', format: 'individual' })
		]);
		const solved = (n: number) => Math.max(4 - Math.floor(n / 16), 1);
		expect(batch.rows.map((r) => [r.result.place, r.result.solved, r.result.penaltyMinutes])).toEqual(
			Array.from({ length: 64 }, (_, i) => [i + 1, solved(i + 1), 100 + 5 * (i + 1)])
		);
		const named = (place: number) => batch.rows.find((r) => r.result.place === place);
		expect(named(1)?.participant.fullName).toBe('Примеров Иван Петрович');
		// Row 19 starts at the bottom of page 1, its times go on at the top of page 2.
		expect(named(19)).toMatchObject({ page: 1, participant: { fullName: 'Пробный Пётр Петрович' } });
		// A name wrapped onto two lines of its cell.
		expect(named(48)?.participant.fullName).toBe('Черновой Денис Петрович');
	});

	it('reads the rows of the same protocol by a row pattern over the cells of its table', async () => {
		const pattern: MappingProfile = {
			...profile('protocol-tasks-profile.json'),
			columns: {},
			pdf: {
				rowPattern: '(?<place>\\d+)\\t(?<fullName>[^\\t]+)\\t(?:[^\\t]*\\t){4}(?<solved>\\d+)\\t(?<penaltyMinutes>\\d+)'
			}
		};
		const bytes = fixture('protocol-tasks.pdf');
		const result = await feedFor(bytes, () => docparse).readBatch({
			bytes,
			declaredName: 'batch',
			profile: pattern,
			declaredComplete: false,
			requestId: 'test-fsp-import'
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.issues).toEqual([]);
		expect(result.value.rows.map((r) => r.result.place)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
	});
});
