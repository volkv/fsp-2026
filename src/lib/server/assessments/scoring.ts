// From a score to the evidence (docs/domain.md, sections 9 and 10.3): the append-only score, the attempt `scored`, and —
// when the level of the version is reached — the `platform_test` fact with its claims by the coverage, the next
// profile revision and the recalculation of the category in the same transaction.
import { createHash } from 'node:crypto';
import { eq, max } from 'drizzle-orm';
import type { AuditActor } from '$lib/server/audit/record';
import type { Transaction } from '$lib/server/db';
import { assessmentArtifacts, assessmentAttempts, assessmentScores, claims, sourceFacts } from '$lib/server/db/schema';
import type { JobCreator } from '$lib/server/jobs/queue';
import { canonicalJson } from '$lib/server/json/canonical';
import { recordEvidenceChange } from '$lib/server/resumes/revision';
import type { ArtifactDraft } from '$lib/server/sandbox/artifacts';
import type { AssessmentLevel } from './bank';
import type { LoadedVersion } from './versions';

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface StoredArtifactDraft {
	id?: string;
	kind: ArtifactDraft['kind'] | 'quiz_step';
	content: Record<string, unknown>;
}

/**
 * Appends artifacts after the last one of the attempt; the hash is over the canonical JSON of the content. `at` is the
 * moment of the action they record: the quiz measures answer times by it.
 */
export async function appendArtifacts(
	tx: Transaction,
	attemptId: string,
	drafts: readonly StoredArtifactDraft[],
	at: Date,
	retentionUntil: string
): Promise<string[]> {
	if (drafts.length === 0) return [];
	const [last] = await tx
		.select({ seq: max(assessmentArtifacts.seq) })
		.from(assessmentArtifacts)
		.where(eq(assessmentArtifacts.attemptId, attemptId));
	const start = (last?.seq ?? 0) + 1;
	const rows = await tx
		.insert(assessmentArtifacts)
		.values(
			drafts.map((draft, index) => ({
				...(draft.id === undefined ? {} : { id: draft.id }),
				attemptId,
				seq: start + index,
				kind: draft.kind,
				content: draft.content,
				sha256: sha256Hex(canonicalJson(draft.content)),
				createdAt: at,
				retentionUntil
			}))
		)
		.returning({ id: assessmentArtifacts.id });
	return rows.map((row) => row.id);
}

/** The level a score reaches on the scale of its version, or the `below` value of the scale. */
export interface ScoredLevel {
	level: string;
	/** `null` — the level of the version is not reached: no fact, nothing is claimed. */
	confirmed: { level: AssessmentLevel; levelStrength: number; gradeKey: AssessmentLevel | null } | null;
}

export interface ScoreInput {
	attempt: { id: string; candidateId: string };
	version: LoadedVersion;
	score: number;
	maxScore: number;
	level: ScoredLevel;
	/** Language of the solution; the coverage may confirm a skill only for some languages. */
	language: string | null;
	/** Extra facts of the result shown with it: the confidence of a quiz level, its ability estimate. */
	details: Record<string, number | string>;
	now: Date;
	requestId: string;
	createdBy: JobCreator;
}

export interface ScoreOutcome {
	scoreId: string;
	factId: string | null;
	skillKeys: string[];
}

const SYSTEM: AuditActor = { kind: 'system' };

/** Skills of the coverage the attempt confirms: all of them, except those tied to other languages. */
export function confirmedSkills(version: LoadedVersion, language: string | null): string[] {
	return version.coverage.skills
		.filter((skill) => !skill.languages || (language !== null && (skill.languages as string[]).includes(language)))
		.map((skill) => skill.skillKey)
		.sort();
}

/**
 * Records an automatic score of an attempt in `submitted`. A reached level produces the fact: the group of dependent
 * evidence is the assessment (every attempt of it), so retakes never add up (domain 9.3).
 */
export async function recordAutomaticScore(tx: Transaction, input: ScoreInput): Promise<ScoreOutcome> {
	const { attempt, version, now } = input;
	const [score] = await tx
		.insert(assessmentScores)
		.values({
			attemptId: attempt.id,
			score: String(input.score),
			maxScore: String(input.maxScore),
			level: input.level.level,
			scoredBy: 'automatic',
			scorerVersion: `${version.scorer.type}@${version.scorer.version}`
		})
		.returning({ id: assessmentScores.id });
	if (!score) throw new Error('score was not inserted');
	await tx.update(assessmentAttempts).set({ status: 'scored' }).where(eq(assessmentAttempts.id, attempt.id));

	const confirmed = input.level.confirmed;
	if (confirmed === null) return { scoreId: score.id, factId: null, skillKeys: [] };

	const skillKeys = confirmedSkills(version, input.language);
	const scoredOn = now.toISOString().slice(0, 10);
	const payload = {
		assessmentId: version.assessmentId,
		assessmentTitle: version.title,
		kind: version.kind,
		versionId: version.id,
		version: version.version,
		attemptId: attempt.id,
		scoreId: score.id,
		skillKeys,
		level: confirmed.level,
		levelStrength: confirmed.levelStrength,
		gradeKey: confirmed.gradeKey,
		score: input.score,
		maxScore: input.maxScore,
		language: input.language,
		scoredOn,
		details: input.details
	};
	const [fact] = await tx
		.insert(sourceFacts)
		.values({
			candidateId: attempt.candidateId,
			source: 'platform_test',
			factType: 'test_score',
			sourceRecordRef: `test:score:${score.id}`,
			eventKey: `test:assessment:${version.assessmentId}`,
			trustLevel: 'platform_verified',
			ownershipBasis: 'own_attempt',
			ownershipRef: attempt.id,
			payload,
			payloadSha256: sha256Hex(canonicalJson(payload)),
			observedAt: now,
			lastVerifiedAt: now,
			occurredOn: scoredOn,
			status: 'active'
		})
		.returning({ id: sourceFacts.id });
	if (!fact) throw new Error('fact was not inserted');
	if (skillKeys.length > 0) {
		await tx.insert(claims).values(
			skillKeys.map((skillKey) => ({
				candidateId: attempt.candidateId,
				factId: fact.id,
				claimType: 'skill_mention' as const,
				rawText: `Подтверждено платформой: задание «${version.title}» v${version.version}, уровень ${confirmed.level}`,
				polarity: 'asserted' as const,
				skillKey,
				value: { assessment_id: version.assessmentId, level: confirmed.level, level_strength: confirmed.levelStrength },
				extractor: 'source_mapping' as const,
				status: 'active' as const
			}))
		);
	}
	await recordEvidenceChange(tx, {
		candidateId: attempt.candidateId,
		withdrawal: false,
		reason: 'assessment_scored',
		requestId: input.requestId,
		actor: SYSTEM,
		createdBy: input.createdBy
	});
	return { scoreId: score.id, factId: fact.id, skillKeys };
}
