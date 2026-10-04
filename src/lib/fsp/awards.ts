// Awards of an FSP result (contracts 1.3), from the highest: the one order of the server and the pages.

export const AWARDS = ['winner', 'prize', 'finalist', 'participant'] as const;
export type Award = (typeof AWARDS)[number];

const isAward = (value: unknown): value is Award => (AWARDS as readonly unknown[]).includes(value);

/** Position of an award from the highest (`0`); an absent or unknown award ranks below every award. */
export const awardRank = (award: string | null | undefined): number =>
	isAward(award) ? AWARDS.indexOf(award) : AWARDS.length;
