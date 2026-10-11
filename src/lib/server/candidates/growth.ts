// «Карта роста»: the required skills the candidate lacks most often across the vacancies of the feed «Вакансии для вас»
// within reach — a match and a role match of at least a half, so that the vacancies of other roles do not crowd the map — with the same
// gaps of `matchScore`, and how many of them each skill would clear completely, being the only missing one there. A hint where confirming a skill pays off, not a promise of invitations.
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { MAX_PAGE_SIZE } from '$lib/server/matching/page';
import { recommendVacancies } from '$lib/server/matching/recommendations';

export interface SkillGrowth {
	/** Vacancies counted: those of the top of the feed within reach. */
	vacancies: number;
	/** Of them, those with at least one required skill missing. */
	withGaps: number;
	/** The best match among them, 0..1; `null` without vacancies. */
	best: number | null;
	/** The most frequent gaps first. */
	skills: { skillKey: string; vacancies: number; clears: number }[];
}

const TOP = 5;
const REACH = 0.5;

export async function skillGrowth(executor: Executor, subject: AccessSubject): Promise<SkillGrowth> {
	const page = await recommendVacancies({ db: executor }, subject, { limit: MAX_PAGE_SIZE });
	const counts = new Map<string, { vacancies: number; clears: number }>();
	let withGaps = 0;
	const reach = page.items.filter(
		(item) => item.match.score >= REACH && (item.match.components.role.value ?? 0) >= REACH
	);
	for (const item of reach) {
		const missing = [
			...new Set(
				item.match.explanation.gaps.flatMap((gap) => (gap.code === 'required_skill_missing' ? [gap.skill_key] : []))
			)
		];
		if (missing.length > 0) withGaps += 1;
		for (const key of missing) {
			const entry = counts.get(key) ?? { vacancies: 0, clears: 0 };
			entry.vacancies += 1;
			if (missing.length === 1) entry.clears += 1;
			counts.set(key, entry);
		}
	}
	return {
		vacancies: reach.length,
		withGaps,
		best: page.items.reduce<number | null>(
			(top, item) => (top === null ? item.match.score : Math.max(top, item.match.score)),
			null
		),
		skills: [...counts.entries()]
			.map(([skillKey, entry]) => ({ skillKey, ...entry }))
			.sort((a, b) => b.vacancies - a.vacancies || b.clears - a.clears || a.skillKey.localeCompare(b.skillKey))
			.slice(0, TOP)
	};
}
