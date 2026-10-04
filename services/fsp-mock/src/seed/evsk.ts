// Which EVSK norm a place fulfils, by competition status and age group: tables of the EVSK requirements for
// sport programming (order of the Ministry of Sport No. 299 of 2026, appendix 77; the same tables in order No. 450 of
// 2024, appendix 24). The platform's taxonomy holds the same norm (taxonomy/fsp-strength.json, evskNorm); a test keeps
// the two equal. The source records this as "fulfilled", not as an assigned rank.

import type { AgeGroup, CompetitionLevel, DisciplineCode, EvskRank, Stage } from '../types.ts';

type Ranges = readonly (readonly [EvskRank, number, number])[];

/** `[rank, fromPlace, toPlace]`, best rank first. */
const TABLE: Partial<Record<CompetitionLevel, Partial<Record<AgeGroup, Ranges>>>> = {
	world_championship: {
		adults: [
			['MS', 1, 1],
			['KMS', 2, 8]
		],
		// «Первенство мира» (under 19).
		juniors_u19: [['KMS', 1, 5]]
	},
	european_championship: {
		adults: [
			['MS', 1, 1],
			['KMS', 2, 6]
		],
		// «Первенство Европы» (under 19).
		juniors_u19: [['KMS', 1, 4]]
	},
	// Other international competitions of the EKP: adults only.
	international_ekp: {
		adults: [
			['MS', 1, 1],
			['KMS', 2, 3]
		]
	},
	russian_championship: {
		adults: [
			['MS', 1, 1],
			['KMS', 2, 4],
			['I', 5, 9]
		]
	},
	russian_cup: {
		adults: [
			['KMS', 1, 3],
			['I', 4, 8]
		]
	},
	russian_youth_championship: {
		juniors_u19: [
			['KMS', 1, 1],
			['I', 2, 8]
		]
	},
	all_russian_ekp: {
		adults: [
			['KMS', 1, 2],
			['I', 3, 4]
		],
		juniors_u19: [['I', 1, 3]]
	},
	all_russian_sport_event: {
		adults: [
			['II', 1, 2],
			['III', 3, 6]
		],
		juniors_u26: [
			['II', 1, 2],
			['III', 3, 5]
		],
		juniors_u19: [
			['II', 1, 1],
			['III', 2, 4]
		]
	},
	universiade: {
		juniors_u26: [
			['KMS', 1, 1],
			['I', 2, 3],
			['II', 4, 5]
		]
	},
	federal_district: {
		adults: [
			['I', 1, 2],
			['II', 3, 4],
			['III', 5, 8]
		],
		juniors_u19: [
			['I', 1, 1],
			['II', 2, 3],
			['III', 4, 5]
		]
	},
	interregional_ekp: {
		adults: [
			['I', 1, 1],
			['II', 2, 4]
		],
		juniors_u19: [
			['I', 1, 1],
			['II', 2, 3]
		]
	},
	regional_championship: {
		adults: [
			['I', 1, 2],
			['II', 3, 4],
			['III', 5, 6]
		]
	},
	regional_cup: {
		adults: [
			['I', 1, 1],
			['II', 2, 3],
			['III', 4, 5]
		]
	},
	regional_youth: {
		juniors_u19: [
			['II', 1, 1],
			['III', 2, 4],
			['Y1', 5, 8]
		],
		boys_girls_u15: [
			['III', 1, 3],
			['Y1', 4, 6],
			['Y2', 8, 9]
		]
	},
	regional_other: {
		adults: [
			['II', 1, 2],
			['III', 3, 4]
		],
		juniors_u19: [
			['III', 1, 2],
			['Y1', 3, 4],
			['Y2', 5, 8]
		],
		// Place 3 is listed for both Y1 and Y2 in the order; the first listed rank applies.
		boys_girls_u15: [
			['III', 1, 1],
			['Y1', 2, 3],
			['Y2', 3, 5],
			['Y3', 6, 8]
		]
	},
	municipal: {
		adults: [
			['II', 1, 2],
			['III', 3, 4]
		],
		juniors_u19: [
			['III', 1, 1],
			['Y1', 2, 3],
			['Y2', 4, 6],
			['Y3', 7, 8]
		],
		boys_girls_u15: [
			['Y1', 1, 2],
			['Y2', 3, 4],
			['Y3', 5, 6]
		]
	}
};

/** Minimum age for a rank to be fulfilled. */
const MIN_AGE: Record<EvskRank, number> = { MS: 16, KMS: 15, I: 14, II: 14, III: 14, Y1: 12, Y2: 12, Y3: 12 };

/** The u15 group exists only in algorithmic programming and robotics. */
const U15_DISCIPLINES: ReadonlySet<DisciplineCode> = new Set(['algorithmic', 'robotics']);

export function evskFulfilled(input: {
	level: CompetitionLevel;
	stage: Stage;
	ageGroup: AgeGroup;
	discipline: DisciplineCode;
	place: number;
	ageAtCompetition: number;
}): EvskRank | null {
	// A qualifier never fulfils a norm: the tables name the final (or the only) stage.
	if (input.stage === 'qualifier') return null;
	if (input.ageGroup === 'boys_girls_u15' && !U15_DISCIPLINES.has(input.discipline)) return null;
	const ranges = TABLE[input.level]?.[input.ageGroup];
	if (!ranges) return null;
	for (const [rank, from, to] of ranges) {
		if (input.place >= from && input.place <= to) {
			return input.ageAtCompetition >= MIN_AGE[rank] ? rank : null;
		}
	}
	return null;
}

/** Who assigns a rank: MS — the federal ministry, KMS and adult ranks — the region, youth ranks — the municipality. */
export function assigningAuthority(rank: EvskRank, region: string): string {
	if (rank === 'MS') return 'Минспорт России';
	if (rank === 'KMS' || rank === 'I') return `Орган исполнительной власти в области спорта: ${region}`;
	return `Орган местного самоуправления в области спорта: ${region}`;
}
