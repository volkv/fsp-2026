// Vectors of candidate sections and vacancies in one embedding space (docs/domain.md, sections 16.3, 17.1): what has to
// be computed, the call to the model, and the conditional write. A section whose text is the same as the stored one is
// not sent to the model again: its vector moves to the new revision. Shared by `profile.embed` and `embedding.reindex`.
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { candidates, embeddings, vacancies } from '$lib/server/db/schema';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import type { ModelError } from '$lib/server/ml/result';
import { vacancyEmbedText } from '$lib/server/vacancies/embed-job';
import { EMBEDDED_CANDIDATE_STATUSES, type CandidateProfile } from './profile';
import type { ProfileSection } from './text';

export type EmbedModels = Pick<ModelAdapter, 'embed'>;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Vacancies without vectors: closed ones take part in no match. */
export const UNEMBEDDED_VACANCY_STATUSES = ['closed'] as const;

interface Input {
	/** `candidate:section` or the vacancy id; unique within one call. */
	key: string;
	text: string;
	sha: string;
}

export interface CandidatePlan {
	candidateId: string;
	revision: number;
	/** Sections the model computes. */
	embed: (Input & { section: ProfileSection })[];
	/** Sections with the stored text: the vector moves to `revision`. */
	keep: ProfileSection[];
	/** Stored sections the profile no longer has. */
	remove: ProfileSection[];
}

const sectionKey = (candidateId: string, section: string) => `${candidateId}:${section}`;

/**
 * What changes for each profile in the space; profiles whose stored vectors are all of the current revision, or that
 * have neither vectors nor text, need nothing and are left out.
 */
export async function planCandidates(
	executor: Executor,
	spaceId: string,
	profiles: readonly CandidateProfile[]
): Promise<CandidatePlan[]> {
	if (profiles.length === 0) return [];
	const stored = await executor
		.select({
			ownerId: embeddings.ownerId,
			section: embeddings.section,
			inputSha256: embeddings.inputSha256,
			inputVersion: embeddings.inputVersion
		})
		.from(embeddings)
		.where(
			and(
				eq(embeddings.spaceId, spaceId),
				eq(embeddings.ownerType, 'candidate_section'),
				inArray(
					embeddings.ownerId,
					profiles.map((profile) => profile.id)
				)
			)
		);
	const storedOf = new Map<string, typeof stored>();
	for (const row of stored) {
		const list = storedOf.get(row.ownerId) ?? [];
		list.push(row);
		storedOf.set(row.ownerId, list);
	}

	const plans: CandidatePlan[] = [];
	for (const profile of profiles) {
		const rows = storedOf.get(profile.id) ?? [];
		const revision = String(profile.revision);
		if (rows.length > 0 && rows.every((row) => row.inputVersion === revision)) {
			const storedSections = new Set(rows.map((row) => row.section));
			const current = profile.sections.map((s) => s.section);
			if (current.length === storedSections.size && current.every((section) => storedSections.has(section))) continue;
		}
		const bySection = new Map(rows.map((row) => [row.section, row]));
		const plan: CandidatePlan = {
			candidateId: profile.id,
			revision: profile.revision,
			embed: [],
			keep: [],
			remove: []
		};
		for (const { section, text } of profile.sections) {
			const sha = sha256(text);
			if (bySection.get(section)?.inputSha256 === sha) plan.keep.push(section);
			else plan.embed.push({ key: sectionKey(profile.id, section), section, text, sha });
		}
		const current = new Set(profile.sections.map((s) => s.section));
		for (const row of rows) {
			if (row.section !== null && !current.has(row.section as ProfileSection)) {
				plan.remove.push(row.section as ProfileSection);
			}
		}
		if (plan.embed.length + plan.keep.length + plan.remove.length > 0) plans.push(plan);
	}
	return plans;
}

export type Embedded =
	{ ok: true; vectors: Map<string, number[]>; latencyMs: number } | { ok: false; error: ModelError };

/** Document vectors of the inputs in the space; the adapter cuts them into batches of `EMBED_BATCH_SIZE`. */
export async function embedDocuments(
	models: EmbedModels,
	spaceId: string,
	inputs: readonly Pick<Input, 'key' | 'text'>[],
	signal: AbortSignal
): Promise<Embedded> {
	if (inputs.length === 0) return { ok: true, vectors: new Map(), latencyMs: 0 };
	const response = await models.embed(
		{ spaceId, inputs: inputs.map((input) => ({ id: input.key, kind: 'document', text: input.text })) },
		{ priority: 'background', signal }
	);
	if (!response.ok) return { ok: false, error: response.error };
	const vectors = new Map(response.value.vectors.map((v) => [v.id, v.vector]));
	for (const input of inputs) {
		if (!vectors.has(input.key)) throw new Error('embed returned no vector for an input');
	}
	return { ok: true, vectors, latencyMs: response.value.latencyMs };
}

/**
 * Revisions of the candidates, their rows locked until the commit: against a concurrent change of the evidence, and
 * against another writer of the same candidate's vectors (`profile.embed` and `embedding.reindex` may meet), whose
 * delete-and-insert of a section would otherwise collide on the unique index. Locked in id order.
 */
export async function lockedRevisions(tx: Transaction, candidateIds: readonly string[]): Promise<Map<string, number>> {
	if (candidateIds.length === 0) return new Map();
	const rows = await tx
		.select({ id: candidates.id, revision: candidates.profileRevision })
		.from(candidates)
		.where(inArray(candidates.id, [...candidateIds]))
		.orderBy(asc(candidates.id))
		.for('update');
	return new Map(rows.map((row) => [row.id, row.revision]));
}

/** Writes the plan of one candidate; the caller has checked that the revision is still current. */
export async function writeCandidatePlan(
	tx: Transaction,
	spaceId: string,
	plan: CandidatePlan,
	vectors: ReadonlyMap<string, number[]>
): Promise<void> {
	const version = String(plan.revision);
	const owner = and(
		eq(embeddings.spaceId, spaceId),
		eq(embeddings.ownerType, 'candidate_section'),
		eq(embeddings.ownerId, plan.candidateId)
	);
	const replaced = [...plan.remove, ...plan.embed.map((input) => input.section)];
	if (replaced.length > 0) await tx.delete(embeddings).where(and(owner, inArray(embeddings.section, replaced)));
	if (plan.embed.length > 0) {
		await tx.insert(embeddings).values(
			plan.embed.map((input) => {
				const vector = vectors.get(input.key);
				if (!vector) throw new Error('a planned section has no vector');
				return {
					ownerType: 'candidate_section' as const,
					ownerId: plan.candidateId,
					section: input.section,
					inputSha256: input.sha,
					inputVersion: version,
					spaceId,
					vector
				};
			})
		);
	}
	if (plan.keep.length > 0) {
		await tx
			.update(embeddings)
			.set({ inputVersion: version })
			.where(and(owner, inArray(embeddings.section, plan.keep)));
	}
}

/** Removes the vectors of candidates that are no longer searched (a deleted or ineligible profile). */
export async function removeUnembeddedCandidates(tx: Transaction, spaceId: string): Promise<number> {
	const gone = await tx
		.delete(embeddings)
		.where(
			and(
				eq(embeddings.spaceId, spaceId),
				eq(embeddings.ownerType, 'candidate_section'),
				notInArray(
					embeddings.ownerId,
					tx
						.select({ id: sql`${candidates.id}::text` })
						.from(candidates)
						.where(inArray(candidates.status, [...EMBEDDED_CANDIDATE_STATUSES]))
				)
			)
		)
		.returning({ id: embeddings.id });
	return gone.length;
}

export interface VacancyPlan {
	vacancyId: string;
	revision: number;
	input: Input;
	/** The stored vector has the same text: it moves to `revision`. */
	keep: boolean;
}

/** Vacancies whose vector in the space is missing or not of the current revision. */
export async function planVacancies(
	executor: Executor,
	spaceId: string,
	vacancyIds: readonly string[]
): Promise<VacancyPlan[]> {
	if (vacancyIds.length === 0) return [];
	const rows = await executor
		.select({
			id: vacancies.id,
			revision: vacancies.revision,
			title: vacancies.title,
			roleKey: vacancies.roleKey,
			requiredSkillKeys: vacancies.requiredSkillKeys,
			niceSkillKeys: vacancies.niceSkillKeys,
			description: vacancies.description
		})
		.from(vacancies)
		.where(inArray(vacancies.id, [...vacancyIds]));
	const stored = await executor
		.select({ ownerId: embeddings.ownerId, inputSha256: embeddings.inputSha256, inputVersion: embeddings.inputVersion })
		.from(embeddings)
		.where(
			and(
				eq(embeddings.spaceId, spaceId),
				eq(embeddings.ownerType, 'vacancy'),
				inArray(
					embeddings.ownerId,
					rows.map((row) => row.id)
				)
			)
		);
	const storedOf = new Map(stored.map((row) => [row.ownerId, row]));
	const plans: VacancyPlan[] = [];
	for (const row of rows) {
		const current = storedOf.get(row.id);
		if (current?.inputVersion === String(row.revision)) continue;
		const text = vacancyEmbedText(row);
		const sha = sha256(text);
		plans.push({
			vacancyId: row.id,
			revision: row.revision,
			input: { key: row.id, text, sha },
			keep: current?.inputSha256 === sha
		});
	}
	return plans;
}

/** Writes the vectors of the vacancies still at their planned revision; returns the ids written. */
export async function writeVacancyPlans(
	tx: Transaction,
	spaceId: string,
	plans: readonly VacancyPlan[],
	vectors: ReadonlyMap<string, number[]>
): Promise<VacancyPlan[]> {
	if (plans.length === 0) return [];
	const locked = await tx
		.select({ id: vacancies.id, revision: vacancies.revision })
		.from(vacancies)
		.where(
			inArray(
				vacancies.id,
				plans.map((plan) => plan.vacancyId)
			)
		)
		// As lockedRevisions: `vacancy.embed` checks its revision under a share lock, so the two writers take turns.
		.orderBy(asc(vacancies.id))
		.for('update');
	const revisions = new Map(locked.map((row) => [row.id, row.revision]));
	const written: VacancyPlan[] = [];
	for (const plan of plans) {
		if (revisions.get(plan.vacancyId) !== plan.revision) continue;
		const owner = and(
			eq(embeddings.spaceId, spaceId),
			eq(embeddings.ownerType, 'vacancy'),
			eq(embeddings.ownerId, plan.vacancyId)
		);
		if (plan.keep) {
			await tx
				.update(embeddings)
				.set({ inputVersion: String(plan.revision) })
				.where(owner);
		} else {
			const vector = vectors.get(plan.input.key);
			if (!vector) throw new Error('a planned vacancy has no vector');
			await tx.delete(embeddings).where(owner);
			await tx.insert(embeddings).values({
				ownerType: 'vacancy',
				ownerId: plan.vacancyId,
				inputSha256: plan.input.sha,
				inputVersion: String(plan.revision),
				spaceId,
				vector
			});
		}
		written.push(plan);
	}
	return written;
}
