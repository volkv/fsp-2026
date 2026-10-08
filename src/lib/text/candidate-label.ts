// How a company names a candidate on its screens and in its letters (docs/domain.md, section 14). The pseudonym — a
// keyed hash of the candidate and the company, 26 characters of base32 — stays the identifier of the URL and the API;
// people read a short code of it: «Кандидат CRYUVD». The code is the head of the pseudonym, so it says no more about
// the candidate than the pseudonym does, and the same candidate has the same code on every screen of the company.
//
// Six base32 characters are 2^30 codes: two candidates of one list of n share a code with probability about
// n² / 2^31 — under 10⁻⁵ for a hundred, the largest page of the catalog (`MAX_PAGE_SIZE`).

const CANDIDATE_CODE_LENGTH = 6;

/**
 * The short code of a pseudonym: «CRYUVD». Views shared by both sides carry the pseudonym only to the company (`null`
 * to the candidate); a company's screen without it is a broken view, not a nameless candidate.
 */
export function candidateCode(pseudonym: string | null): string {
	if (pseudonym === null) throw new Error('a company names a candidate by the pseudonym, and the view has none');
	if (pseudonym.length < CANDIDATE_CODE_LENGTH) throw new Error('a pseudonym is shorter than its code');
	return pseudonym.slice(0, CANDIDATE_CODE_LENGTH).toUpperCase();
}

/** The candidate as the company's screens name them: «Кандидат CRYUVD». */
export function candidateLabel(pseudonym: string | null): string {
	return `Кандидат ${candidateCode(pseudonym)}`;
}
