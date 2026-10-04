// The profile texts of candidates read from the evidence active right now (docs/domain.md, sections 9, 14, 17.3):
// facts, claims and experience entries of withdrawn, superseded or annulled facts, and whatever the candidate rejected,
// never reach a text. Every candidate comes with the `profile_revision` it was read at; the change that alters its
// evidence moves the revision in the same transaction, so a text is current exactly while the revision is. A profile
// without `pd_processing` in effect (for ages 14–17 with the representative's signature) has no texts and no vectors.
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { processingAllowedFor } from '$lib/server/consent/processing';
import type { Executor } from '$lib/server/db';
import { candidates, claims, experienceEntries, sourceFacts } from '$lib/server/db/schema';
import { latestPublishedVersion, readTaxonomyNames } from '$lib/server/taxonomy/vocabulary';
import { ageBand } from '$lib/server/visibility/age';
import { profileSections, type CompetitionResult, type ExperienceGroup, type SectionText } from './text';

/** Candidates whose profile has vectors; the others have none (a deleted or ineligible profile is not searched). */
export const EMBEDDED_CANDIDATE_STATUSES = ['onboarding', 'active'] as const;

/** Names of taxonomy keys; a key without a name in the latest published version stands for itself. */
export interface TaxonomyLabels {
	role(key: string): string;
	skill(key: string): string;
}

export async function loadTaxonomyLabels(executor: Executor): Promise<TaxonomyLabels> {
	const version = await latestPublishedVersion(executor);
	const names = version ? await readTaxonomyNames(executor, version.id) : null;
	const roles = new Map(names?.roles.map((role) => [role.key, role.name]));
	const skills = new Map(names?.skills.map((skill) => [skill.key, skill.name]));
	return { role: (key) => roles.get(key) ?? key, skill: (key) => skills.get(key) ?? key };
}

export interface CandidateProfile {
	id: string;
	/** `profile_revision` the evidence was read at. */
	revision: number;
	/** Whether the profile has vectors at all: `EMBEDDED_CANDIDATE_STATUSES` and `pd_processing` in effect at `at`. */
	embedded: boolean;
	sections: SectionText[];
}

const competitionPayload = z.object({
	result: z.object({ status: z.string(), award: z.string().optional() }),
	competition: z.object({ discipline: z.string(), level: z.string(), online: z.boolean().optional() })
});

function yearOf(date: string | null): number | null {
	return date === null ? null : Number(date.slice(0, 4));
}

/**
 * Profiles of the candidates, read in one snapshot. A candidate missing from the database is missing from the map.
 * `at` decides whether a candidate is an adult, which the text of results depends on.
 */
export async function loadCandidateProfiles(
	executor: Executor,
	candidateIds: readonly string[],
	labels: TaxonomyLabels,
	at: Date
): Promise<Map<string, CandidateProfile>> {
	const result = new Map<string, CandidateProfile>();
	if (candidateIds.length === 0) return result;
	const ids = [...new Set(candidateIds)];

	const rows = await executor
		.select({
			id: candidates.id,
			status: candidates.status,
			revision: candidates.profileRevision,
			desiredRoleKeys: candidates.desiredRoleKeys,
			birthDate: candidates.birthDate,
			birthDatePrecision: candidates.birthDatePrecision,
			birthDateStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.where(inArray(candidates.id, ids));
	const processable = await processingAllowedFor(executor, ids, at);

	const skillRows = await executor
		.select({ candidateId: claims.candidateId, skillKey: claims.skillKey })
		.from(claims)
		.innerJoin(sourceFacts, eq(sourceFacts.id, claims.factId))
		.where(
			and(
				inArray(claims.candidateId, ids),
				eq(claims.claimType, 'skill_mention'),
				eq(claims.polarity, 'asserted'),
				eq(claims.status, 'active'),
				ne(claims.candidateReview, 'rejected'),
				isNotNull(claims.skillKey),
				eq(sourceFacts.status, 'active')
			)
		);

	const experienceRows = await executor
		.select({
			candidateId: experienceEntries.candidateId,
			roleKey: experienceEntries.roleKey,
			periodStatus: experienceEntries.periodStatus,
			periodFrom: experienceEntries.periodFrom,
			periodTo: experienceEntries.periodTo,
			isCurrent: experienceEntries.isCurrent,
			appliedSkillKeys: experienceEntries.appliedSkillKeys
		})
		.from(experienceEntries)
		.innerJoin(sourceFacts, eq(sourceFacts.id, experienceEntries.factId))
		.where(
			and(
				inArray(experienceEntries.candidateId, ids),
				eq(experienceEntries.status, 'active'),
				ne(experienceEntries.candidateReview, 'rejected'),
				eq(sourceFacts.status, 'active')
			)
		);

	const resultRows = await executor
		.select({ candidateId: sourceFacts.candidateId, payload: sourceFacts.payload })
		.from(sourceFacts)
		.where(
			and(
				inArray(sourceFacts.candidateId, ids),
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.factType, 'competition_result'),
				eq(sourceFacts.status, 'active')
			)
		);

	const group = <T extends { candidateId: string }>(list: readonly T[]) => {
		const byCandidate = new Map<string, T[]>();
		for (const row of list) {
			const rows = byCandidate.get(row.candidateId) ?? [];
			rows.push(row);
			byCandidate.set(row.candidateId, rows);
		}
		return byCandidate;
	};
	const skillsOf = group(skillRows);
	const experienceOf = group(experienceRows);
	const resultsOf = group(resultRows);

	for (const row of rows) {
		const embedded = (EMBEDDED_CANDIDATE_STATUSES as readonly string[]).includes(row.status) && processable.has(row.id);
		if (!embedded) {
			result.set(row.id, { id: row.id, revision: row.revision, embedded, sections: [] });
			continue;
		}
		const experience: ExperienceGroup[] = (experienceOf.get(row.id) ?? []).map((entry) => {
			const from = entry.periodStatus === 'valid' ? yearOf(entry.periodFrom) : null;
			return {
				role: entry.roleKey === null ? null : labels.role(entry.roleKey),
				years: from === null ? null : { from, to: entry.isCurrent ? null : yearOf(entry.periodTo) },
				skills: entry.appliedSkillKeys.map((key) => labels.skill(key))
			};
		});
		const competitions: CompetitionResult[] = [];
		for (const fact of resultsOf.get(row.id) ?? []) {
			const payload = competitionPayload.parse(fact.payload);
			if (payload.result.status !== 'official') continue;
			competitions.push({
				discipline: payload.competition.discipline,
				level: payload.competition.level,
				award: payload.result.award ?? 'unknown',
				online: payload.competition.online ?? null
			});
		}
		const age = ageBand(
			{ birthDate: row.birthDate, precision: row.birthDatePrecision, status: row.birthDateStatus },
			at
		);
		result.set(row.id, {
			id: row.id,
			revision: row.revision,
			embedded,
			sections: profileSections({
				skills: [
					...(skillsOf.get(row.id) ?? []).flatMap((claim) => (claim.skillKey === null ? [] : [claim.skillKey])),
					...(experienceOf.get(row.id) ?? []).flatMap((entry) => entry.appliedSkillKeys)
				].map((key) => labels.skill(key)),
				experience,
				desiredRoles: row.desiredRoleKeys.map((key) => labels.role(key)),
				competitions,
				adult: age === 'adult'
			})
		});
	}
	return result;
}
