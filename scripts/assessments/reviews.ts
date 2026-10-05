// Reviews and Angoff ratings in the descriptors (docs/domain.md, 10.2 and 10.8): who judged, on which sources, and the
// cut of a level from its ratings. A level without ratings keeps its authors' provisional cut in `mean` until
// independent raters rate it; the family's authors are never its reviewers or raters.
import type { AngoffRating, FamilyLevel } from '../../src/lib/server/assessments/contract/bank.ts';
import { SCALE } from '../../src/lib/server/assessments/contract/procedure.ts';

/** The cut of a level: the mean of the ratings on the 1/20 scale, a half rounded up (the stricter cut). */
export function angoffMean(ratings: readonly Pick<AngoffRating, 'p'>[]): number {
	if (ratings.length === 0) throw new Error('a cut from no ratings');
	const mean = ratings.reduce((sum, r) => sum + r.p, 0) / ratings.length;
	return Math.floor(mean * SCALE + 0.5 + 1e-9) / SCALE;
}

/** The angoff block of a level with its ratings: the mean follows the ratings. */
export function withRatings(angoff: FamilyLevel['angoff'], ratings: readonly AngoffRating[]): FamilyLevel['angoff'] {
	return { ...angoff, ratings: [...ratings], mean: angoffMean(ratings) };
}
