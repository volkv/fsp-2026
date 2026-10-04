// `profile.embed` against the database with a fake embedding runtime: which evidence reaches the section texts, the
// conditional write at the revision the texts were read at, the section vectors that move to a new revision without a
// model call, and the explicit failure modes (docs/domain.md, sections 16, 17; contracts 3.3, 3.5).
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthDeps, RequestMeta } from '$lib/server/auth/context';
import { unlinkFspIdentity } from '$lib/server/auth/identities';
import type { SessionRef } from '$lib/server/auth/sessions';
import { createProfileEmbedHandler, type ProfileEmbedDeps } from '$lib/server/candidates/embed-job';
import { updateProfileSettings } from '$lib/server/candidates/settings';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	candidates,
	claims,
	consentEvents,
	embeddingSpaces,
	embeddings,
	experienceEntries,
	externalIdentities,
	jobs,
	mlResults,
	passwordCredentials,
	sourceFacts
} from '$lib/server/db/schema';
import type { EmbedModels } from '$lib/server/embeddings/vectors';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import type { Mailer } from '$lib/server/mail/mailer';
import type { EmbedRequest } from '$lib/server/ml/adapter';
import { fail, ok, type ModelResult } from '$lib/server/ml/result';
import type { Redis } from '$lib/server/redis';
import { recordEvidenceChange } from '$lib/server/resumes/revision';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createPublishedDocument, randomSha256 } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const SPACE = 'test-space@r1/q:none/d:none/mean/l2/4/t512/sections-v1';

let database: TestDatabase;

/** Records every text it gets; answers with a vector of the text or with the configured failure. */
class FakeEmbedder implements EmbedModels {
	texts: string[] = [];
	failure: ReturnType<typeof fail> | null = null;

	embed(
		request: EmbedRequest
	): Promise<ModelResult<{ spaceId: string; vectors: { id: string; vector: number[] }[]; latencyMs: number }>> {
		if (this.failure) return Promise.resolve(this.failure);
		this.texts.push(...request.inputs.map((input) => input.text));
		return Promise.resolve(
			ok({
				spaceId: request.spaceId,
				vectors: request.inputs.map((input) => ({ id: input.id, vector: vectorOf(input.text) })),
				latencyMs: 1
			})
		);
	}
}

function vectorOf(text: string): number[] {
	const v = [1, 0, 0, 0];
	for (let i = 0; i < text.length; i++) v[i % 4] = (v[i % 4] ?? 0) + text.charCodeAt(i) / 1000;
	const norm = Math.hypot(...v);
	return v.map((x) => x / norm);
}

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	await database.db.insert(embeddingSpaces).values({
		id: SPACE,
		modelName: 'test-embedder',
		modelRevision: 'r1',
		dimension: 4,
		queryPrefix: '',
		documentPrefix: '',
		pooling: 'mean',
		normalization: 'l2',
		maxInputTokens: 512,
		chunkingVersion: 'sections-v1',
		status: 'building'
	});
}, 180_000);

afterAll(async () => {
	await database.drop();
});

beforeEach(async () => {
	// Every test runs its own jobs; the envelopes keep finished ones.
	await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
});

/** The test space: built by the first tests, active from then on (a space never returns to `building`). */
async function activateSpace() {
	await database.db
		.update(embeddingSpaces)
		.set({ status: 'active', activatedAt: new Date() })
		.where(and(eq(embeddingSpaces.id, SPACE), eq(embeddingSpaces.status, 'building')));
}

async function fact(candidateId: string, source: 'resume' | 'fsp', payload: Record<string, unknown>) {
	const [row] = await database.db
		.insert(sourceFacts)
		.values({
			candidateId,
			source,
			factType: source === 'fsp' ? 'competition_result' : 'resume_document',
			sourceRecordRef: `${source}:${randomSha256().slice(0, 12)}`,
			trustLevel: source === 'fsp' ? 'fsp_verified' : 'claimed',
			ownershipBasis: source === 'fsp' ? 'operator_confirmed' : 'self_upload',
			payload,
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		})
		.returning();
	if (!row) throw new Error('fact not inserted');
	return row;
}

async function skillClaim(
	candidateId: string,
	factId: string,
	skillKey: string,
	overrides: Partial<typeof claims.$inferInsert> = {}
) {
	await database.db.insert(claims).values({
		candidateId,
		factId,
		claimType: 'skill_mention',
		rawText: skillKey,
		polarity: 'asserted',
		skillKey,
		extractor: 'source_mapping',
		status: 'active',
		...overrides
	});
}

/** A candidate with a resume (skills, one job at a named company) and one FSP result. */
async function profiledCandidate() {
	const candidate = await createCandidate(database.db, { desiredRoleKeys: ['backend'] });
	const resume = await fact(candidate.id, 'resume', { resume_document_id: 'r' });
	await skillClaim(candidate.id, resume.id, 'go');
	await skillClaim(candidate.id, resume.id, 'python');
	await skillClaim(candidate.id, resume.id, 'rust', { candidateReview: 'rejected' });
	await skillClaim(candidate.id, resume.id, 'java', { polarity: 'negated' });
	await database.db.insert(experienceEntries).values({
		candidateId: candidate.id,
		factId: resume.id,
		positionTitle: 'Ведущий инженер платформы',
		roleKey: 'backend',
		organizationName: 'ООО «Секретная Компания»',
		periodFrom: '2021-03-01',
		periodFromPrecision: 'month',
		isCurrent: true,
		appliedSkillKeys: ['go', 'kotlin'],
		quotes: [{ block_id: 'b1', start: 0, end: 5 }],
		periodStatus: 'valid',
		status: 'active'
	});
	await fact(candidate.id, 'fsp', {
		result: { status: 'official', award: 'prize', team: { name: 'Северный ветер' } },
		competition: { discipline: 'product', level: 'russian_cup', online: false, title: 'Кубок России, финал' }
	});
	const withdrawn = await fact(candidate.id, 'resume', { resume_document_id: 'old' });
	await database.db.update(sourceFacts).set({ status: 'withdrawn' }).where(eq(sourceFacts.id, withdrawn.id));
	await skillClaim(candidate.id, withdrawn.id, 'php');
	await database.db.update(candidates).set({ profileRevision: 3 }).where(eq(candidates.id, candidate.id));
	return candidate;
}

function deps(models: FakeEmbedder, spaceId: string | null = SPACE): ProfileEmbedDeps {
	return { models: () => models, spaceId: () => spaceId, now: () => new Date('2026-09-25T00:00:00Z') };
}

async function enqueue(candidateId: string, revision: number) {
	await database.db.insert(jobs).values({
		type: 'profile.embed',
		typeVersion: 1,
		payload: { candidate_id: candidateId },
		inputVersion: String(revision),
		dedupKey: `profile.embed:${candidateId}`,
		status: 'queued',
		priority: JOB_TYPES['profile.embed'].priority,
		maxAttempts: JOB_TYPES['profile.embed'].maxAttempts,
		createdBy: { kind: 'system' }
	});
}

async function runEmbed(
	models: FakeEmbedder,
	options: { spaceId?: string | null; beforeWrite?: () => Promise<void> } = {}
) {
	const claimed = await claimJob(database.db, 'test-worker', ['profile.embed']);
	if (claimed?.type !== 'profile.embed') throw new Error('no profile.embed job to run');
	const job: ClaimedJob<'profile.embed'> = {
		...claimed,
		type: 'profile.embed',
		payload: JOB_TYPES['profile.embed'].payload.parse(claimed.payload)
	};
	const result = await createProfileEmbedHandler(
		deps(models, options.spaceId === undefined ? SPACE : options.spaceId)
	).run({
		job,
		db: database.db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({}, () => undefined)
	});
	await options.beforeWrite?.();
	return { outcome: await completeJob(database.db, job, result), job };
}

async function vectorsOf(candidateId: string) {
	return database.db
		.select({ section: embeddings.section, inputVersion: embeddings.inputVersion, inputSha256: embeddings.inputSha256 })
		.from(embeddings)
		.where(and(eq(embeddings.ownerId, candidateId), eq(embeddings.spaceId, SPACE)))
		.orderBy(embeddings.section);
}

describe('profile.embed', () => {
	it('is enqueued with the new revision by every change of the resume evidence', async () => {
		const candidate = await createCandidate(database.db);
		const revision = await database.db.transaction((tx) =>
			recordEvidenceChange(tx, {
				candidateId: candidate.id,
				withdrawal: false,
				reason: 'test',
				requestId: 'test',
				actor: { kind: 'system' },
				createdBy: { kind: 'system' }
			})
		);
		const queued = await database.db
			.select({ type: jobs.type, inputVersion: jobs.inputVersion })
			.from(jobs)
			.where(eq(jobs.dedupKey, `profile.embed:${candidate.id}`));
		expect(queued).toEqual([{ type: 'profile.embed', inputVersion: String(revision) }]);
	});

	it('is enqueued with the new revision when the desired roles change, and not by work terms alone', async () => {
		const { db } = database;
		const candidate = await createCandidate(db, { desiredRoleKeys: [] });
		const subject = {
			userId: candidate.userId,
			via: 'session' as const,
			candidate: { id: candidate.id, status: 'active' as const },
			membership: null,
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		const queued = () =>
			db
				.select({ inputVersion: jobs.inputVersion })
				.from(jobs)
				.where(and(eq(jobs.dedupKey, `profile.embed:${candidate.id}`), eq(jobs.status, 'queued')));
		const revision = async () =>
			(await db.select().from(candidates).where(eq(candidates.id, candidate.id)))[0]?.profileRevision;

		// Desired roles are a line of the profile text: a new revision of the vectors.
		await updateProfileSettings(db, subject, { preferences: {}, desiredRoleKeys: ['backend'] });
		expect(await queued()).toEqual([{ inputVersion: String(await revision()) }]);

		// Work terms are not in the text: the revision moves for matching, the vectors stay.
		await db.delete(jobs).where(eq(jobs.status, 'queued'));
		await updateProfileSettings(db, subject, {
			preferences: { work_formats: ['remote'] },
			desiredRoleKeys: ['backend']
		});
		expect(await queued()).toEqual([]);
	});

	it('is enqueued with the new revision when an FSP identity is unlinked and its facts withdrawn', async () => {
		const issuer = 'https://id.fsp.test';
		const candidate = await createCandidate(database.db);
		const [identity] = await database.db
			.insert(externalIdentities)
			.values({
				userId: candidate.userId,
				issuer,
				subject: 'athlete-1',
				linkedAt: new Date(),
				linkMethod: 'signup_via_provider'
			})
			.returning();
		if (!identity) throw new Error('identity not inserted');
		await database.db
			.insert(passwordCredentials)
			.values({ userId: candidate.userId, hash: '$argon2id$v=19$m=19456,t=2,p=1$x$y', changedAt: new Date() });
		const [link] = await database.db
			.insert(athleteLinks)
			.values({
				userId: candidate.userId,
				source: 'fsp',
				sourceAthleteId: identity.subject,
				basisIdentityId: identity.id,
				resolutionMethod: 'subject_equals_athlete_id',
				status: 'active',
				linkedAt: new Date()
			})
			.returning();
		if (!link) throw new Error('link not inserted');
		const document = await createPublishedDocument(database.db, 'fsp_import');
		const [consent] = await database.db
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidate.id,
				kind: 'fsp_import',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: candidate.userId,
				method: 'separate_screen_button',
				evidence: {},
				occurredAt: new Date()
			})
			.returning();
		if (!consent) throw new Error('consent not inserted');
		await database.db.insert(sourceFacts).values({
			candidateId: candidate.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'athlete_link',
			ownershipRef: link.id,
			consentEventId: consent.id,
			payload: {},
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		});

		const deps: AuthDeps = {
			db: database.db,
			redis: null as unknown as Redis,
			crypto: null as unknown as FieldCrypto,
			mailer: null as unknown as Mailer,
			appOrigin: 'http://app.test',
			now: () => new Date()
		};
		const meta: RequestMeta = { requestId: 'test', ip: null, userAgent: null };
		const session: SessionRef = { hash: 'x'.repeat(64), userId: candidate.userId, authTime: new Date() };
		const result = await unlinkFspIdentity(deps, meta, session, issuer);
		expect(result).toEqual({ ok: true, withdrawnFacts: 1 });

		const [after] = await database.db
			.select({ profileRevision: candidates.profileRevision })
			.from(candidates)
			.where(eq(candidates.id, candidate.id));
		const queued = await database.db
			.select({ type: jobs.type, inputVersion: jobs.inputVersion })
			.from(jobs)
			.where(eq(jobs.dedupKey, `profile.embed:${candidate.id}`));
		expect(queued).toEqual([{ type: 'profile.embed', inputVersion: String(after?.profileRevision) }]);
	});

	it('embeds the catalog view of the active evidence, section by section, at the current revision', async () => {
		const candidate = await profiledCandidate();
		await enqueue(candidate.id, 3);
		const models = new FakeEmbedder();
		const { outcome, job } = await runEmbed(models);
		expect(outcome).toBe('succeeded');

		expect(models.texts).toEqual([
			'Навыки: Go, Kotlin, Python',
			'Опыт работы: Бэкенд-разработчик, с 2021 по настоящее время; навыки: Go, Kotlin',
			'Желаемые роли: Бэкенд-разработчик\nСоревнования ФСП: Программирование продуктовое — Кубок России, призёр, очно'
		]);
		const all = models.texts.join('\n');
		for (const hidden of ['Секретная', 'Ведущий инженер', 'Северный ветер', 'финал', 'Rust', 'Java', 'PHP']) {
			expect(all).not.toContain(hidden);
		}
		expect((await vectorsOf(candidate.id)).map((v) => [v.section, v.inputVersion])).toEqual([
			['experience', '3'],
			['skills', '3'],
			['summary', '3']
		]);
		const [envelope] = await database.db.select().from(mlResults).where(eq(mlResults.jobId, job.id));
		expect(envelope).toMatchObject({
			operation: 'embed',
			processingMode: 'model',
			inputVersion: '3',
			embeddingSpaceId: SPACE,
			inputRef: { type: 'candidate', id: candidate.id, revision: 3 }
		});
		// The space is being built: nothing searches it yet, so no match is recomputed.
		expect(await database.db.select().from(jobs).where(eq(jobs.type, 'match.refresh'))).toEqual([]);
	});

	it('moves unchanged sections to a new revision without the model and drops a section that is gone', async () => {
		await activateSpace();
		const candidate = await profiledCandidate();
		await enqueue(candidate.id, 3);
		await runEmbed(new FakeEmbedder());
		const before = await vectorsOf(candidate.id);
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));

		await database.db
			.update(candidates)
			.set({ desiredRoleKeys: [], profileRevision: 4 })
			.where(eq(candidates.id, candidate.id));
		await database.db
			.delete(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, candidate.id), eq(sourceFacts.source, 'fsp')));
		await enqueue(candidate.id, 4);
		const models = new FakeEmbedder();
		const { outcome } = await runEmbed(models);
		expect(outcome).toBe('succeeded');
		expect(models.texts).toEqual([]);
		const after = await vectorsOf(candidate.id);
		expect(after.map((v) => [v.section, v.inputVersion])).toEqual([
			['experience', '4'],
			['skills', '4']
		]);
		expect(after.map((v) => v.inputSha256)).toEqual(before.slice(0, 2).map((v) => v.inputSha256));
		// In the active space the semantic component of the candidate's matches is recomputed.
		const refresh = await database.db
			.select({ inputVersion: jobs.inputVersion })
			.from(jobs)
			.where(eq(jobs.dedupKey, `match:candidate:${candidate.id}`));
		expect(refresh).toEqual([{ inputVersion: '4' }]);
	});

	it('discards vectors of a revision that moved while the model was computing them', async () => {
		await activateSpace();
		const candidate = await profiledCandidate();
		await enqueue(candidate.id, 3);
		const { outcome } = await runEmbed(new FakeEmbedder(), {
			beforeWrite: async () => {
				await database.db
					.update(candidates)
					.set({ profileRevision: 4, evidenceFloorRevision: 4 })
					.where(eq(candidates.id, candidate.id));
			}
		});
		expect(outcome).toBe('discarded_stale');
		expect(await vectorsOf(candidate.id)).toEqual([]);
	});

	it('records a model that is off as an explicit failure and retries a runtime that is down', async () => {
		await activateSpace();
		const candidate = await profiledCandidate();
		await enqueue(candidate.id, 3);
		const off = new FakeEmbedder();
		off.failure = fail('disabled', 'embed: switched off by an administrator', { reason: 'switched_off' });
		const { outcome, job } = await runEmbed(off);
		expect(outcome).toBe('succeeded');
		expect(await vectorsOf(candidate.id)).toEqual([]);
		const [envelope] = await database.db.select().from(mlResults).where(eq(mlResults.jobId, job.id));
		expect(envelope).toMatchObject({ processingMode: 'failed', failure: { code: 'disabled', reason: 'switched_off' } });

		await enqueue(candidate.id, 3);
		const down = new FakeEmbedder();
		down.failure = fail('unavailable', 'embed: connection refused');
		const failure = await runEmbed(down).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(JobFailure);
		expect(failure).toMatchObject({ code: 'embed_unavailable', retryable: true });
	});

	it('does nothing without a configured space or while the configured one is not registered', async () => {
		const candidate = await profiledCandidate();
		const models = new FakeEmbedder();
		await enqueue(candidate.id, 3);
		expect((await runEmbed(models, { spaceId: null })).outcome).toBe('succeeded');
		await enqueue(candidate.id, 3);
		expect((await runEmbed(models, { spaceId: 'unregistered-space' })).outcome).toBe('succeeded');
		expect(models.texts).toEqual([]);
		expect(await vectorsOf(candidate.id)).toEqual([]);
	});
});
