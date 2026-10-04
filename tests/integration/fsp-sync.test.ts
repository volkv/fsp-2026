// FSP achievements against the simulator `services/fsp-mock` run as a process: the adapter, the `fsp.sync` job
// (snapshot → facts → claims → receipts, supersede, annul, withdraw only from a complete snapshot) and the webhook,
// delivered by the simulator itself after a change made through its control endpoints.
import { createHmac, createPrivateKey, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	athleteLinks,
	auditEvents,
	candidates,
	categorizationRulesets,
	categorizationRuns,
	claims,
	consentEvents,
	demoSessions,
	externalIdentities,
	inboundEvents,
	jobs,
	skills,
	sourceFacts,
	verificationReceipts
} from '$lib/server/db/schema';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer, type GrantIssuer } from '$lib/server/fsp/grant';
import type { FspIntegration } from '$lib/server/fsp/integration';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { createFspSyncHandler } from '$lib/server/fsp/sync';
import type { Result } from '$lib/server/fsp/types';
import { receiveFspWebhook } from '$lib/server/fsp/webhook';
import { JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import { canonicalJson } from '$lib/server/json/canonical';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { FSP_MOCK_CREDENTIALS, freePort, startFspMock, type FspMock } from '../helpers/fsp-mock';
import { createCandidate, createPublishedDocument, createUser, randomSha256 } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const {
	clientId: CLIENT_ID,
	clientSecret: CLIENT_SECRET,
	assertionSecret: ASSERTION_SECRET,
	webhookSecret: WEBHOOK_SECRET
} = FSP_MOCK_CREDENTIALS;
const RECEIPT_SEED = Buffer.alloc(32, 7);
const WEBHOOK_PATH = '/api/v1/integrations/fsp/webhooks';

let database: TestDatabase;
let mock: FspMock;
let receiver: Server;
let source: HttpAchievementsSource;
let grants: ServiceGrantIssuer;
let integration: FspIntegration;
let handler: JobHandler<'fsp.sync'>;
let issuer: string;
let languageSkills: Set<string>;

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const languages = await database.db.select({ key: skills.key }).from(skills).where(eq(skills.kind, 'language'));
	languageSkills = new Set(languages.map((s) => s.key));

	const receiverPort = await freePort();
	mock = await startFspMock({ webhookUrl: `http://127.0.0.1:${receiverPort}${WEBHOOK_PATH}`, athletes: 400 });
	issuer = mock.issuer;
	// Small pages make a long history span several of them.
	source = new HttpAchievementsSource({ baseUrl: mock.origin, webhookSecret: WEBHOOK_SECRET, pageSize: 7 });
	grants = new ServiceGrantIssuer({
		issuer,
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		assertionSecret: ASSERTION_SECRET
	});
	integration = {
		source,
		grants,
		signer: createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: RECEIPT_SEED })
	};
	handler = createFspSyncHandler(() => integration);

	// The webhook endpoint the simulator delivers to: the same function the route calls.
	receiver = createHttpServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const headers = new Headers();
			for (const [name, value] of Object.entries(req.headers)) {
				if (typeof value === 'string') headers.set(name, value);
			}
			receiveFspWebhook(database.db, source, {
				headers,
				rawBody: new Uint8Array(Buffer.concat(chunks)),
				requestId: `test-${randomUUID()}`,
				ip: '127.0.0.1',
				userAgent: null
			}).then(
				async (response) => {
					res.writeHead(response.status, { 'content-type': 'application/json' });
					res.end(await response.text());
				},
				(error: unknown) => {
					res.writeHead(500).end(String(error));
				}
			);
		});
	});
	await new Promise<void>((resolve) => receiver.listen(receiverPort, '127.0.0.1', resolve));
});

afterAll(async () => {
	await mock.stop();
	await new Promise<void>((resolve, reject) => {
		receiver.closeAllConnections();
		receiver.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
	await database.drop();
});

interface Linked {
	fspId: string;
	userId: string;
	candidateId: string;
	linkId: string;
	consentEventId: string;
}

/**
 * A candidate who signed in with FSP ID, linked the athlete and granted `fsp_import`. With `demoSession` — the clone of
 * such a candidate in that demo session, as a demo session copies it: the account of the seed batch, its identity and
 * link within the session.
 */
async function linkHero(title: string, birthYear: number, demoSession: string | null = null): Promise<Linked> {
	const { db } = database;
	const fspId = await mock.heroId(title);
	const user = await createUser(db, {
		demoSessionId: demoSession,
		seedBatchId: demoSession === null ? null : 'demo-1'
	});
	const candidate = await createCandidate(db, {
		userId: user.id,
		birthDate: `${birthYear}-06-15`,
		demoSessionId: demoSession
	});
	const [identity] = await db
		.insert(externalIdentities)
		.values({
			userId: candidate.userId,
			issuer,
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
	const document = await createPublishedDocument(db, 'fsp_import');
	const [consent] = await db
		.insert(consentEvents)
		.values({
			subjectCandidateId: candidate.id,
			kind: 'fsp_import',
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			method: 'separate_screen_button',
			evidence: { document_sha256: document.bodySha256 },
			occurredAt: new Date(Date.now() - 60_000)
		})
		.returning();
	if (!consent) throw new Error('consent not inserted');
	return { fspId, userId: candidate.userId, candidateId: candidate.id, linkId: link.id, consentEventId: consent.id };
}

type Outcome = 'succeeded' | 'discarded_stale' | 'failed' | 'queued' | 'lease_lost';

async function enqueueSync(linked: Linked): Promise<void> {
	await database.db.transaction((tx) =>
		enqueueJob(
			tx,
			'fsp.sync',
			{ athlete_link_id: linked.linkId },
			{ inputVersion: `${linked.linkId}:${linked.consentEventId}`, createdBy: { kind: 'system' } }
		)
	);
}

/** What the worker does with one captured `fsp.sync` job. */
async function runSync(run: JobHandler<'fsp.sync'> = handler): Promise<Outcome> {
	const { db } = database;
	const claimed: ClaimedJob | null = await claimJob(db, 'test-worker', ['fsp.sync']);
	if (claimed?.type !== 'fsp.sync') throw new Error('no fsp.sync job to run');
	const job: ClaimedJob<'fsp.sync'> = {
		...claimed,
		type: 'fsp.sync',
		payload: JOB_TYPES['fsp.sync'].payload.parse(claimed.payload)
	};
	try {
		const result = await run.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({}, () => undefined)
		});
		return await completeJob(db, job, result);
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		return failJob(
			db,
			job,
			{ code: error.code, retryable: error.retryable, message: error.message },
			error.retryAfterSeconds
		);
	}
}

async function syncOnce(linked: Linked): Promise<Outcome> {
	await enqueueSync(linked);
	return runSync();
}

async function factsOf(candidateId: string) {
	return database.db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, candidateId)).orderBy(sourceFacts.id);
}

async function revisions(candidateId: string) {
	const [row] = await database.db
		.select({ profile: candidates.profileRevision, floor: candidates.evidenceFloorRevision })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error('candidate not found');
	return row;
}

async function auditActions(candidateId: string, action: string) {
	return database.db
		.select()
		.from(auditEvents)
		.where(and(eq(auditEvents.subjectCandidateId, candidateId), eq(auditEvents.action, action)));
}

async function snapshotOf(fspId: string) {
	const grant = await grants.issue({ sourceAthleteId: fspId, consentEventId: randomUUID() });
	if (!grant.ok) throw new Error(`grant failed: ${grant.error.code}`);
	const snapshot = await source.getAchievements({ sourceAthleteId: fspId, grant: grant.value });
	if (!snapshot.ok) throw new Error(`snapshot failed: ${snapshot.error.code}`);
	return snapshot.value;
}

function signedDelivery(body: string, options: { timestamp?: number; secret?: string; eventId?: string } = {}) {
	const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
	const signature = createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
		.update(`${timestamp}.${body}`)
		.digest('hex');
	const eventId = options.eventId ?? (JSON.parse(body) as { eventId: string }).eventId;
	return {
		headers: new Headers({
			'content-type': 'application/json',
			'x-fsp-event-id': eventId,
			'x-fsp-timestamp': String(timestamp),
			'x-fsp-signature': `sha256=${signature}`
		}),
		rawBody: new Uint8Array(Buffer.from(body, 'utf8')),
		requestId: `test-${randomUUID()}`,
		ip: '127.0.0.1',
		userAgent: null
	};
}

describe('fsp-achievements/v1 adapter', () => {
	it('assembles a complete snapshot of a long history across pages', async () => {
		const snapshot = await snapshotOf(await mock.heroId('Длинная история'));
		expect(snapshot.results.length).toBeGreaterThan(20);
		const pages = Math.ceil(snapshot.results.length / 7);
		expect(snapshot.completeness).toMatchObject({ complete: true, pages: { fetched: pages, total: pages } });
		expect(new Set(snapshot.results.map((r) => r.id)).size).toBe(snapshot.results.length);
		const competitions = new Set(snapshot.competitions.map((c) => c.id));
		expect(snapshot.results.every((r) => competitions.has(r.competitionId))).toBe(true);
	});

	it('keeps an unmapped enumeration value as unknown with the raw string', async () => {
		const snapshot = await snapshotOf(await mock.heroId('Неизвестная роль в команде'));
		const result = snapshot.results.find((r) => r.team?.role === 'unknown');
		expect(result?.rawValues?.['team.role']).toBe('оператор');
	});

	it('answers grant_mismatch for a valid grant about another athlete', async () => {
		const owner = await mock.heroId('Капитан, backend, МС');
		const other = await mock.heroId('Командный призёр без специализации');
		const grant = await grants.issue({ sourceAthleteId: owner, consentEventId: randomUUID() });
		if (!grant.ok) throw new Error('grant failed');
		const answer = await source.getAchievements({ sourceAthleteId: other, grant: grant.value });
		expect(answer.ok).toBe(false);
		if (!answer.ok) expect(answer.error).toMatchObject({ code: 'grant_mismatch', retryable: false });
	});

	it('answers grant_invalid for an assertion signed with another secret', async () => {
		const athlete = await mock.heroId('Алгоритмист, КМС');
		const foreign = new ServiceGrantIssuer({
			issuer,
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			assertionSecret: 'another-assertion-secret-0123456789abcdef'
		});
		const grant = await foreign.issue({ sourceAthleteId: athlete, consentEventId: randomUUID() });
		if (!grant.ok) throw new Error('grant failed');
		const answer = await source.getAchievements({ sourceAthleteId: athlete, grant: grant.value });
		expect(answer.ok).toBe(false);
		if (!answer.ok) expect(answer.error.code).toBe('grant_invalid');
	});

	it('resolves the FSP ID subject as the athlete and reports an account without an athlete profile', async () => {
		const athlete = await mock.heroId('Алгоритмист, КМС');
		const grant = await grants.issue({ sourceAthleteId: athlete, consentEventId: randomUUID() });
		if (!grant.ok) throw new Error('grant failed');
		const resolved = await source.resolveAthlete({ identity: { issuer, subject: athlete }, grant: grant.value });
		expect(resolved).toEqual({ ok: true, value: { sourceAthleteId: athlete, method: 'subject_equals_athlete_id' } });

		const disciplines = await source.listDisciplines();
		expect(disciplines.ok && disciplines.value.map((d) => d.code).sort()).toEqual(
			['algorithmic', 'infosec', 'product', 'robotics', 'uas'].sort()
		);
		const missing = await source.getCompetition('no-such-competition');
		expect(!missing.ok && missing.error.code).toBe('not_found');
	});
});

describe('fsp.sync', () => {
	let hero: Linked;

	beforeAll(async () => {
		hero = await linkHero('Алгоритмист, КМС', 2003);
	});

	it('imports the full snapshot of a demo athlete as verified facts, claims and receipts', async () => {
		const snapshot = await snapshotOf(hero.fspId);
		expect(await syncOnce(hero)).toBe('succeeded');

		const facts = await factsOf(hero.candidateId);
		const byType = (type: string) => facts.filter((f) => f.factType === type);
		expect(byType('competition_result')).toHaveLength(snapshot.results.length);
		expect(byType('qualification')).toHaveLength(snapshot.qualifications.length);
		expect(byType('national_team').map((f) => f.sourceRecordRef)).toEqual(['fsp:national_team:algorithmic:2026']);
		expect(byType('platform_rating').length).toBe(snapshot.athlete.platformAccounts?.length ?? 0);
		for (const fact of facts) {
			expect(fact).toMatchObject({
				source: 'fsp',
				trustLevel: 'fsp_verified',
				ownershipBasis: 'athlete_link',
				ownershipRef: hero.linkId,
				consentEventId: hero.consentEventId,
				status: 'active',
				sourceVersion: snapshot.completeness.sourceVersion
			});
		}
		// A result and a rank assigned for it share one group of dependent evidence.
		const basis = snapshot.qualifications.find((q) => q.basisCompetitionId);
		if (basis?.basisCompetitionId) {
			const ref = `fsp:qualification:${basis.id ?? ''}`;
			expect(facts.find((f) => f.sourceRecordRef === ref)?.eventKey).toBe(
				`fsp:competition:${basis.basisCompetitionId}`
			);
		}

		const claimRows = await database.db.select().from(claims).where(eq(claims.candidateId, hero.candidateId));
		const direct = claimRows.filter((c) => (c.value as { attestation?: string }).attestation === 'direct');
		expect(new Set(direct.map((c) => c.skillKey))).toEqual(new Set(['algorithms', 'competitive_programming']));
		const resultClaim = claimRows.find(
			(c) => c.skillKey === 'algorithms' && (c.value as { format_factor?: number }).format_factor !== undefined
		);
		expect(resultClaim?.value).toMatchObject({
			group_key: expect.stringMatching(/^fsp:competition:/) as unknown,
			trust_level: 'fsp_verified',
			format_factor: expect.any(Number) as unknown,
			strength_of_result: expect.any(Number) as unknown
		});
		expect(claimRows.every((c) => c.extractor === 'source_mapping' && c.status === 'active')).toBe(true);

		const receipts = await database.db
			.select()
			.from(verificationReceipts)
			.where(
				inArray(
					verificationReceipts.factId,
					facts.map((f) => f.id)
				)
			);
		expect(receipts.length).toBeGreaterThan(0);
		const publicKey = createPublicKey(
			createPrivateKey({
				key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), RECEIPT_SEED]),
				format: 'der',
				type: 'pkcs8'
			})
		);
		const receipt = receipts[0];
		if (!receipt) throw new Error('no receipt');
		const statement = canonicalJson(receipt.statement);
		expect(verify(null, Buffer.from(statement), publicKey, Buffer.from(receipt.signature, 'base64url'))).toBe(true);
		// Commitments, not the source reference itself, leave the platform.
		expect(statement).not.toContain('fsp:result:');
		expect(receipt).toMatchObject({ audienceCompanyId: null, disclosureLevel: 'generalized', signingKeyId: 'test-1' });

		expect(await revisions(hero.candidateId)).toEqual({ profile: 1, floor: 0 });
		const recalculations = await database.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.type, 'categorization.compute'), eq(jobs.dedupKey, `categorization:${hero.candidateId}`)));
		expect(recalculations).toHaveLength(1);
		// The imported evidence is a new revision of the profile: its vectors are recomputed too.
		const embeds = await database.db
			.select({ inputVersion: jobs.inputVersion })
			.from(jobs)
			.where(and(eq(jobs.type, 'profile.embed'), eq(jobs.dedupKey, `profile.embed:${hero.candidateId}`)));
		expect(embeds).toEqual([{ inputVersion: '1' }]);
		expect(await auditActions(hero.candidateId, 'fsp.sync_completed')).toHaveLength(1);
	});

	it('changes nothing but the verification time on a repeated sync of the same snapshot', async () => {
		const before = await factsOf(hero.candidateId);
		const claimCount = (await database.db.select().from(claims).where(eq(claims.candidateId, hero.candidateId))).length;
		expect(await syncOnce(hero)).toBe('succeeded');
		const after = await factsOf(hero.candidateId);
		expect(after.map((f) => [f.id, f.status, f.payloadSha256])).toEqual(
			before.map((f) => [f.id, f.status, f.payloadSha256])
		);
		expect(after.every((f, i) => f.lastVerifiedAt.getTime() >= (before[i]?.lastVerifiedAt.getTime() ?? 0))).toBe(true);
		expect(await revisions(hero.candidateId)).toEqual({ profile: 1, floor: 0 });
		expect((await database.db.select().from(claims).where(eq(claims.candidateId, hero.candidateId))).length).toBe(
			claimCount
		);
	});

	it('turns a result changed at the source into a new version through the webhook and drops the old contribution', async () => {
		const { db } = database;
		const [taxonomy] = await db.select().from(categorizationRulesets);
		if (!taxonomy) throw new Error('no rule set');
		const [published] = await db
			.insert(categorizationRuns)
			.values({
				candidateId: hero.candidateId,
				inputRevision: 1,
				inputSnapshotSha256: randomSha256(),
				inputRefs: {},
				taxonomyVersionId: taxonomy.taxonomyVersionId,
				rulesetId: taxonomy.id,
				asOf: new Date(),
				computedAt: new Date(),
				origin: 'automatic',
				outcome: 'partial',
				missing: {},
				experienceSummary: {},
				status: 'published'
			})
			.returning();
		if (!published) throw new Error('run not inserted');

		const facts = await factsOf(hero.candidateId);
		const target = facts.find((f) => {
			const payload = f.payload as { result?: Result };
			return payload.result?.status === 'official' && payload.result.place !== null;
		});
		if (!target) throw new Error('no official result');
		const resultId = (target.payload as { result: Result }).result.id;
		const oldClaims = await db.select({ id: claims.id }).from(claims).where(eq(claims.factId, target.id));
		expect(oldClaims.length).toBeGreaterThan(0);

		const patched = await mock.control('PATCH', `results/${resultId}`, { place: 40 });
		expect(patched.status).toBe(200);
		const delivery = (await patched.json()) as {
			webhook: { event: { eventId: string }; deliveries: { attempts: { status: number | null }[] }[] };
		};
		expect(delivery.webhook.deliveries[0]?.attempts[0]?.status).toBe(202);
		const [inbound] = await db
			.select()
			.from(inboundEvents)
			.where(eq(inboundEvents.eventId, delivery.webhook.event.eventId));
		expect(inbound?.eventType).toBe('result.published');
		const [queued] = await db
			.select()
			.from(jobs)
			.where(and(eq(jobs.type, 'fsp.sync'), eq(jobs.status, 'queued')));
		expect(queued?.createdBy).toEqual({ kind: 'webhook', id: inbound?.id });

		expect(await runSync()).toBe('succeeded');
		const [old] = await db.select().from(sourceFacts).where(eq(sourceFacts.id, target.id));
		expect(old?.status).toBe('superseded');
		const [current] = await db
			.select()
			.from(sourceFacts)
			.where(and(eq(sourceFacts.sourceRecordRef, target.sourceRecordRef), eq(sourceFacts.status, 'active')));
		expect((current?.payload as { result: Result }).result.place).toBe(40);
		const invalidated = await db.select({ status: claims.status }).from(claims).where(eq(claims.factId, target.id));
		expect(invalidated.every((c) => c.status === 'invalidated')).toBe(true);
		const { profile, floor } = await revisions(hero.candidateId);
		expect(profile).toBe(2);
		expect(floor).toBe(profile);
		const [run] = await db.select().from(categorizationRuns).where(eq(categorizationRuns.id, published.id));
		expect(run?.status).toBe('blocked');
	});

	it('accepts a repeated delivery of the same event without a second job', async () => {
		const body = JSON.stringify({
			eventId: `evt-${randomUUID()}`,
			type: 'athlete.updated',
			occurredAt: new Date().toISOString(),
			athleteIds: [hero.fspId, 'unknown-athlete']
		});
		const first = await receiveFspWebhook(database.db, source, signedDelivery(body));
		expect(first.status).toBe(202);
		const second = await receiveFspWebhook(database.db, source, signedDelivery(body));
		expect(second.status).toBe(202);
		expect(await second.json()).toEqual({ accepted: true });
		const waiting = await database.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.type, 'fsp.sync'), eq(jobs.status, 'queued')));
		expect(waiting).toHaveLength(1);
		expect(await runSync()).toBe('succeeded');
	});

	it('stops without calling the source when the consent was revoked after enqueueing', async () => {
		const linked = await linkHero('Спортсмен без результатов', 1998);
		await enqueueSync(linked);
		const [grant] = await database.db.select().from(consentEvents).where(eq(consentEvents.id, linked.consentEventId));
		if (!grant) throw new Error('no consent');
		await database.db.insert(consentEvents).values({
			subjectCandidateId: linked.candidateId,
			kind: 'fsp_import',
			documentId: grant.documentId,
			action: 'revoke',
			signerKind: 'subject',
			signerUserId: linked.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date()
		});
		const failing: FspIntegration = {
			...integration,
			grants: { issue: () => Promise.reject(new Error('the source must not be called')) }
		};
		expect(await runSync(createFspSyncHandler(() => failing))).toBe('discarded_stale');
		expect(await factsOf(linked.candidateId)).toHaveLength(0);
	});

	it('recomputes the matches when the sync changes only the birth date', async () => {
		const { db } = database;
		// The candidate declares another year than the source gives: the sync turns the date into a conflict.
		await db.update(candidates).set({ birthDate: '1990-06-15' }).where(eq(candidates.id, hero.candidateId));
		// Recalculations left waiting by the earlier syncs would absorb new ones: they are done with.
		const waiting = and(eq(jobs.status, 'queued'), sql`${jobs.payload} ->> 'candidate_id' = ${hero.candidateId}`);
		await db.update(jobs).set({ status: 'cancelled', finishedAt: new Date() }).where(waiting);
		const before = await factsOf(hero.candidateId);
		const revision = await revisions(hero.candidateId);

		expect(await syncOnce(hero)).toBe('succeeded');
		const [after] = await db
			.select({ status: candidates.birthDateStatus })
			.from(candidates)
			.where(eq(candidates.id, hero.candidateId));
		expect(after?.status).toBe('conflict');
		expect((await factsOf(hero.candidateId)).map((f) => [f.id, f.status])).toEqual(before.map((f) => [f.id, f.status]));
		// A new revision without a withdrawn ground: the floor stays, the category input is the same, the matches follow.
		expect(await revisions(hero.candidateId)).toEqual({ profile: revision.profile + 1, floor: revision.floor });
		expect(await db.select({ type: jobs.type, inputVersion: jobs.inputVersion }).from(jobs).where(waiting)).toEqual([
			{ type: 'match.refresh', inputVersion: String(revision.profile + 1) }
		]);
	});
});

describe('fsp.sync with an incomplete snapshot', () => {
	it('does not withdraw absent records until a complete snapshot confirms their absence', async () => {
		const linked = await linkHero('Длинная история', 2002);
		expect(await syncOnce(linked)).toBe('succeeded');
		const facts = await factsOf(linked.candidateId);
		const removed = facts.find((f) => f.factType === 'competition_result');
		if (!removed) throw new Error('no result');
		const resultId = (removed.payload as { result: Result }).result.id;
		expect((await mock.control('DELETE', `results/${resultId}?notify=false`)).status).toBe(200);

		expect((await mock.control('PUT', 'faults', { mode: 'partial', athleteId: linked.fspId })).status).toBe(200);
		expect(await syncOnce(linked)).toBe('succeeded');
		const [kept] = await database.db.select().from(sourceFacts).where(eq(sourceFacts.id, removed.id));
		expect(kept?.status).toBe('active');
		const skipped = await auditActions(linked.candidateId, 'fsp.withdrawals_skipped_incomplete');
		expect(skipped.map((e) => e.details)).toEqual([{ missing_count: 1, reason: 'source_declared_partial' }]);
		expect(await revisions(linked.candidateId)).toEqual({ profile: 1, floor: 0 });

		expect((await mock.control('DELETE', 'faults')).status).toBe(204);
		expect(await syncOnce(linked)).toBe('succeeded');
		const [gone] = await database.db.select().from(sourceFacts).where(eq(sourceFacts.id, removed.id));
		expect(gone).toMatchObject({ status: 'withdrawn', statusReason: 'absent_from_complete_snapshot' });
		expect(await revisions(linked.candidateId)).toEqual({ profile: 2, floor: 2 });
	});

	it('fails a structurally broken answer without writing anything, then keeps annulled and preliminary apart', async () => {
		const linked = await linkHero('Аннулированный и предварительный результаты', 2000);
		expect(
			(await mock.control('PUT', 'faults', { mode: 'malformed', athleteId: linked.fspId, remaining: 1 })).status
		).toBe(200);
		expect(await syncOnce(linked)).toBe('failed');
		const [job] = await database.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.type, 'fsp.sync'), eq(jobs.dedupKey, `fsp.sync:${linked.linkId}`)));
		expect(job?.lastError).toMatchObject({ code: 'protocol_error', retryable: false });
		expect(await factsOf(linked.candidateId)).toHaveLength(0);

		expect(await syncOnce(linked)).toBe('succeeded');
		const facts = await factsOf(linked.candidateId);
		const status = (f: (typeof facts)[number]) => (f.payload as { result?: Result }).result?.status;
		const annulled = facts.filter((f) => status(f) === 'annulled');
		const preliminary = facts.filter((f) => status(f) === 'preliminary');
		expect(annulled.map((f) => f.status)).toEqual(['annulled']);
		expect(preliminary.map((f) => f.status)).toEqual(['active']);
		const outside = [...annulled, ...preliminary].map((f) => f.id);
		expect(await database.db.select().from(claims).where(inArray(claims.factId, outside))).toEqual([]);
		expect(
			await database.db.select().from(verificationReceipts).where(inArray(verificationReceipts.factId, outside))
		).toEqual([]);
	});

	it('returns a rate-limited sync to the queue after the Retry-After of the source', async () => {
		const linked = await linkHero('Неизвестная роль в команде', 2005);
		expect(
			(await mock.control('PUT', 'faults', { mode: 'rate_limited', athleteId: linked.fspId, remaining: 1 })).status
		).toBe(200);
		expect(await syncOnce(linked)).toBe('queued');
		const [job] = await database.db
			.select({
				runAfter: jobs.runAfter,
				lastError: jobs.lastError,
				delay: sql<number>`extract(epoch from ${jobs.runAfter} - now())`
			})
			.from(jobs)
			.where(and(eq(jobs.dedupKey, `fsp.sync:${linked.linkId}`), eq(jobs.status, 'queued')));
		expect(job?.lastError).toMatchObject({ code: 'rate_limited', retryable: true });
		expect(Number(job?.delay)).toBeLessThanOrEqual(2);
		await database.db
			.update(jobs)
			.set({ runAfter: new Date(0) })
			.where(eq(jobs.dedupKey, `fsp.sync:${linked.linkId}`));
		expect(await runSync()).toBe('succeeded');
		// The unmapped team role stays unknown in the fact and yields no team-role claim.
		const facts = await factsOf(linked.candidateId);
		const unknownRole = facts.find((f) => (f.payload as { result?: Result }).result?.team?.role === 'unknown');
		expect(unknownRole).toBeDefined();
		const roleClaims = await database.db
			.select()
			.from(claims)
			.where(and(eq(claims.factId, unknownRole?.id ?? ''), eq(claims.claimType, 'team_role')));
		expect(roleClaims).toHaveLength(0);
	});
});

describe('grant_mismatch', () => {
	it('fails the sync for good and records a security event', async () => {
		const linked = await linkHero('Капитан, backend, МС', 1999);
		const other = await mock.heroId('Командный призёр без специализации');
		// A grant about another athlete: what a wrong link or a confused source would produce.
		const foreign: GrantIssuer = { issue: (input) => grants.issue({ ...input, sourceAthleteId: other }) };
		await enqueueSync(linked);
		expect(await runSync(createFspSyncHandler(() => ({ ...integration, grants: foreign })))).toBe('failed');
		const [job] = await database.db
			.select()
			.from(jobs)
			.where(eq(jobs.dedupKey, `fsp.sync:${linked.linkId}`));
		expect(job?.lastError).toMatchObject({ code: 'grant_mismatch', retryable: false });
		const events = await auditActions(linked.candidateId, 'fsp.grant_mismatch');
		expect(events.map((e) => [e.outcome, e.objectType, e.objectId])).toEqual([
			['denied', 'athlete_link', linked.linkId]
		]);
		expect(await auditActions(linked.candidateId, 'fsp.sync_completed')).toEqual([]);
		expect(await factsOf(linked.candidateId)).toHaveLength(0);
	});
});

describe('team results', () => {
	it('never confirm a skill directly and never yield a programming language without a specialization', async () => {
		for (const [title, year] of [
			['Командный призёр без специализации', 2001],
			['Онлайн-отбор против очного финала', 2004]
		] as const) {
			const linked = await linkHero(title, year);
			expect(await syncOnce(linked)).toBe('succeeded');
			const facts = await factsOf(linked.candidateId);
			const teamFacts = facts.filter((f) => (f.payload as { result?: Result }).result?.team);
			expect(teamFacts.length).toBeGreaterThan(0);
			const teamClaims = await database.db
				.select()
				.from(claims)
				.where(
					inArray(
						claims.factId,
						teamFacts.map((f) => f.id)
					)
				);
			expect(teamClaims.length).toBeGreaterThan(0);
			expect(teamClaims.filter((c) => (c.value as { attestation?: string }).attestation === 'direct')).toEqual([]);
			const skillClaims = teamClaims.filter((c) => c.claimType === 'skill_mention');
			expect(skillClaims.every((c) => (c.value as { team_factor?: number }).team_factor !== undefined)).toBe(true);
			const withoutSpecialization = teamFacts.filter(
				(f) => (f.payload as { result: Result }).result.team?.specialization == null
			);
			const languages = teamClaims.filter(
				(c) =>
					withoutSpecialization.some((f) => f.id === c.factId) && c.skillKey !== null && languageSkills.has(c.skillKey)
			);
			expect(languages).toEqual([]);
		}
	});
});

describe('webhook', () => {
	const event = () =>
		JSON.stringify({
			eventId: `evt-${randomUUID()}`,
			type: 'result.published',
			occurredAt: new Date().toISOString(),
			athleteIds: ['athlete-1']
		});

	it('refuses a bad signature and an old timestamp with 401 and records the rejection', async () => {
		const { db } = database;
		const cases = [
			{
				reason: 'signature_invalid',
				delivery: signedDelivery(event(), { secret: 'wrong-secret-0123456789abcdef0123' })
			},
			{
				reason: 'timestamp_skew',
				delivery: signedDelivery(event(), { timestamp: Math.floor(Date.now() / 1000) - 301 })
			},
			{ reason: 'payload_invalid', delivery: signedDelivery(event(), { eventId: 'another-event' }) }
		];
		for (const { reason, delivery } of cases) {
			const response = await receiveFspWebhook(db, source, delivery);
			expect(response.status, reason).toBe(401);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
			const [rejected] = await db
				.select()
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'fsp.webhook_rejected'), eq(auditEvents.requestId, delivery.requestId)));
			expect(rejected?.details, reason).toEqual({ reason });
		}
		const eventIds = await db.select({ id: inboundEvents.eventId }).from(inboundEvents);
		expect(eventIds.map((e) => e.id)).not.toContain('another-event');
	});

	it('accepts a correctly signed event about unknown athletes without storing them or enqueueing', async () => {
		const before = await database.db.select({ id: jobs.id }).from(jobs);
		const response = await receiveFspWebhook(database.db, source, signedDelivery(event()));
		expect(response.status).toBe(202);
		expect(await database.db.select({ id: jobs.id }).from(jobs)).toHaveLength(before.length);
	});
});

describe('the link of a demo-session clone', () => {
	it('is never synchronized: the webhook enqueues the original only, and a sync of the clone stops', async () => {
		const { db } = database;
		const [session] = await db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + 86_400_000) })
			.returning();
		if (!session) throw new Error('demo session not inserted');
		// The athlete linked outside sessions by «team results» above.
		const title = 'Онлайн-отбор против очного финала';
		const [original] = await db
			.select({ linkId: athleteLinks.id })
			.from(athleteLinks)
			.where(
				and(
					eq(athleteLinks.sourceAthleteId, await mock.heroId(title)),
					eq(athleteLinks.status, 'active'),
					sql`${athleteLinks.demoSessionId} is null`
				)
			);
		if (!original) throw new Error('the athlete has no link outside sessions');
		const clone = await linkHero(title, 2004, session.id);

		const body = JSON.stringify({
			eventId: `evt-${randomUUID()}`,
			type: 'athlete.updated',
			occurredAt: new Date().toISOString(),
			athleteIds: [clone.fspId]
		});
		expect((await receiveFspWebhook(db, source, signedDelivery(body))).status).toBe(202);
		const waiting = await db
			.select({ linkId: sql<string>`${jobs.payload}->>'athlete_link_id'` })
			.from(jobs)
			.where(and(eq(jobs.type, 'fsp.sync'), eq(jobs.status, 'queued')));
		expect(waiting.map((job) => job.linkId)).toEqual([original.linkId]);
		expect(await runSync()).toBe('succeeded');

		// Enqueued past the webhook, the sync of the clone's link stops before the source is called.
		await enqueueSync(clone);
		const failing: FspIntegration = {
			...integration,
			grants: { issue: () => Promise.reject(new Error('the source must not be called')) }
		};
		expect(await runSync(createFspSyncHandler(() => failing))).toBe('discarded_stale');
		expect(await factsOf(clone.candidateId)).toHaveLength(0);
	});
});
