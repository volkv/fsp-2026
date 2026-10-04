import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';

import { evskFulfilled } from '../src/seed/evsk.ts';
import { DISCIPLINE_CODES, type AgeGroup, type CompetitionLevel, type EvskRank, type Stage } from '../src/types.ts';

/** The EVSK norm of the platform's taxonomy: the simulator must fulfil exactly the same norms. */
interface TaxonomyNorm {
	minAge: Record<EvskRank, number>;
	eligibleStages: Stage[];
	u15Disciplines: string[];
	placeOverlap: 'first_listed_rank';
	rows: {
		level: CompetitionLevel;
		ageGroup: AgeGroup;
		ranges: { rank: EvskRank; fromPlace: number; toPlace: number }[];
	}[];
}

const NORM = (
	JSON.parse(await readFile(new URL('../../../taxonomy/fsp-strength.json', import.meta.url), 'utf8')) as {
		evskNorm: TaxonomyNorm;
	}
).evskNorm;

const SCHEMA = JSON.parse(
	await readFile(new URL('../../../contracts/fsp-achievements/v1.schema.json', import.meta.url), 'utf8')
) as { $defs: { CompetitionLevel: { enum: CompetitionLevel[] } } };

const LEVELS = SCHEMA.$defs.CompetitionLevel.enum;
const AGE_GROUPS: readonly AgeGroup[] = ['boys_girls_u15', 'juniors_u19', 'juniors_u26', 'adults'];
const STAGES: readonly Stage[] = ['qualifier', 'final', 'single'];
const AGES = [12, 13, 14, 15, 16, 30];
const PLACES = Array.from({ length: 12 }, (_, i) => i + 1);

/** The taxonomy's reading of the norm, written independently of the simulator's table. */
function expected(input: {
	level: CompetitionLevel;
	ageGroup: AgeGroup;
	discipline: string;
	stage: Stage;
	place: number;
	age: number;
}): EvskRank | null {
	if (!NORM.eligibleStages.includes(input.stage)) return null;
	if (input.ageGroup === 'boys_girls_u15' && !NORM.u15Disciplines.includes(input.discipline)) return null;
	const row = NORM.rows.find((r) => r.level === input.level && r.ageGroup === input.ageGroup);
	const range = row?.ranges.find((r) => input.place >= r.fromPlace && input.place <= r.toPlace);
	if (!range) return null;
	return input.age >= NORM.minAge[range.rank] ? range.rank : null;
}

describe('EVSK norms of the simulator', () => {
	it('match the taxonomy norm for every level, age group, discipline, stage, place and age', () => {
		assert.equal(NORM.placeOverlap, 'first_listed_rank');
		let checked = 0;
		for (const level of LEVELS) {
			for (const ageGroup of AGE_GROUPS) {
				for (const discipline of DISCIPLINE_CODES) {
					for (const stage of STAGES) {
						for (const place of PLACES) {
							for (const age of AGES) {
								const actual = evskFulfilled({ level, ageGroup, discipline, stage, place, ageAtCompetition: age });
								const wanted = expected({ level, ageGroup, discipline, stage, place, age });
								assert.equal(actual, wanted, `${level} ${ageGroup} ${discipline} ${stage} place ${place} age ${age}`);
								checked += 1;
							}
						}
					}
				}
			}
		}
		assert.ok(checked > 10_000, `${checked} combinations`);
	});

	it('gives KMS for places 1–5 of the world and 1–4 of the European under-19 championships only', () => {
		const at = (level: CompetitionLevel, place: number) =>
			evskFulfilled({
				level,
				ageGroup: 'juniors_u19',
				discipline: 'algorithmic',
				stage: 'final',
				place,
				ageAtCompetition: 17
			});
		assert.equal(at('world_championship', 5), 'KMS');
		assert.equal(at('world_championship', 6), null);
		assert.equal(at('european_championship', 4), 'KMS');
		assert.equal(at('european_championship', 5), null);
		assert.equal(at('international_ekp', 1), null, 'other international competitions have adult norms only');
	});
});
