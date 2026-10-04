// The dataset of the FSP simulator, generated here from the same seed and size as the running simulator: the seed
// picks the athletes it links to candidates from it and reads their names, regions and disciplines. The achievements
// themselves reach the platform only through `fsp.sync` from the simulator's API, as on a real stand.
import { generateWorld } from '../../../../services/fsp-mock/src/seed/generate.ts';
import { HEROES } from '../../../../services/fsp-mock/src/seed/heroes.ts';
import type { AthleteRecord, World } from '../../../../services/fsp-mock/src/store.ts';

export type { World };

export interface WorldAthlete {
	fspId: string;
	lastName: string;
	firstName: string;
	middleName: string | null;
	birthYear: number;
	region: string | null;
	email: string;
	/** The discipline of most of the athlete's results; the specialization most often stated in its teams. */
	discipline: string;
	specialization: string | null;
	officialResults: number;
}

export function demoWorld(settings: { seed: string; athletes: number }): World {
	return generateWorld({ seed: settings.seed, athletes: settings.athletes });
}

function mostFrequent(values: readonly string[]): string | null {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	let best: string | null = null;
	let bestCount = 0;
	for (const [value, n] of counts) {
		if (n > bestCount) {
			best = value;
			bestCount = n;
		}
	}
	return best;
}

function describe(world: World, record: AthleteRecord): WorldAthlete {
	const { athlete } = record;
	const account = world.accounts.get(athlete.fspId);
	if (!account) throw new Error(`athlete ${athlete.fspId} of the simulator has no FSP ID account`);
	const official = record.results.filter((r) => r.status === 'official');
	const disciplines = official
		.map((r) => world.competitions.get(r.competitionId)?.discipline)
		.filter((d): d is Exclude<typeof d, undefined | 'unknown'> => d !== undefined && d !== 'unknown');
	const specializations = official.map((r) => r.team?.specialization).filter((s): s is string => typeof s === 'string');
	if (athlete.birthYear == null) throw new Error(`athlete ${athlete.fspId} of the simulator has no birth year`);
	return {
		fspId: athlete.fspId,
		lastName: athlete.lastName,
		firstName: athlete.firstName,
		middleName: athlete.middleName ?? null,
		birthYear: athlete.birthYear,
		region: athlete.region ?? null,
		email: account.email,
		discipline: mostFrequent(disciplines) ?? 'algorithmic',
		specialization: mostFrequent(specializations),
		officialResults: official.length
	};
}

/** A demo athlete of the simulator by the key of `heroes.ts`. */
export function heroAthlete(world: World, key: string): WorldAthlete {
	const hero = HEROES.find((h) => h.key === key);
	if (!hero) throw new Error(`the simulator has no demo athlete «${key}»`);
	const record = world.athletes.get(hero.fspId);
	if (!record) throw new Error(`demo athlete «${key}» is missing from the generated dataset`);
	return describe(world, record);
}

/**
 * Athletes for synthetic candidates: adults by the year of birth on `now` (so no representative is needed), with at
 * least one official result, none of the simulator's demo athletes (they stay for the scenarios of signing in).
 * The order is the dataset's own, so the same world gives the same list.
 */
export function eligibleAthletes(world: World, now: Date): WorldAthlete[] {
	const heroes = new Set(HEROES.map((h) => h.fspId));
	const adultBorn = now.getUTCFullYear() - 19;
	const result: WorldAthlete[] = [];
	for (const record of world.athletes.values()) {
		if (heroes.has(record.athlete.fspId)) continue;
		const birthYear = record.athlete.birthYear;
		if (birthYear == null || birthYear > adultBorn) continue;
		if (!record.results.some((r) => r.status === 'official')) continue;
		result.push(describe(world, record));
	}
	return result;
}

/**
 * Minors with official results of the product discipline: one of them becomes a candidate whose representative's
 * authority is verified (the internship scenario).
 */
export function minorAthletes(world: World, now: Date): WorldAthlete[] {
	const heroes = new Set(HEROES.map((h) => h.fspId));
	const year = now.getUTCFullYear();
	const result: WorldAthlete[] = [];
	for (const record of world.athletes.values()) {
		const birthYear = record.athlete.birthYear;
		if (heroes.has(record.athlete.fspId) || birthYear == null) continue;
		// 15–16 by the year of birth: 14–17 on any day of the year.
		if (year - birthYear < 15 || year - birthYear > 16) continue;
		const described = describe(world, record);
		if (described.officialResults > 0 && described.discipline === 'product') result.push(described);
	}
	return result;
}

/** The competition of the catalog a selector names, e.g. the final of the Russian Cup 2025 of the product discipline. */
export function findCompetition(
	world: World,
	selector: { discipline: string; level: string; stage: string; year: number }
): { id: string; title: string } {
	for (const competition of world.competitions.values()) {
		if (
			competition.discipline === selector.discipline &&
			competition.level === selector.level &&
			competition.stage === selector.stage &&
			competition.startDate.startsWith(String(selector.year))
		) {
			return { id: competition.id, title: competition.title };
		}
	}
	throw new Error(
		`the simulator has no competition ${selector.discipline} ${selector.level} ${selector.stage} ${selector.year}`
	);
}
