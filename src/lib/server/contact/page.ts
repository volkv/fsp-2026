// What the cabinet pages of contact — requests of a confirmation, calls of companies, applications — work with: the
// configured database, field crypto and clock; and the names of the catalog the pages show.
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { CATEGORY_GRADE_NAMES } from '$lib/server/categories/labels';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import type { ApplicationDeps } from '$lib/server/applications/service';
import type { ChallengeDeps } from '$lib/server/challenges/company';
import type { ConfirmationDeps } from '$lib/server/confirmations/requests';

export function contactPageDeps(): ConfirmationDeps & ChallengeDeps & ApplicationDeps {
	return { db: db(), crypto: fieldCrypto(), now: () => new Date() };
}

/** Titles of the specializations and the blocks of the catalog, names of its grades by the taxonomy. */
export function catalogNames() {
	return {
		specializations: Object.fromEntries(CATALOG.specializations.map((s) => [s.key, s.title])),
		grades: CATEGORY_GRADE_NAMES,
		blocks: Object.fromEntries(CATALOG.blocks.map((b) => [b.code, b.title]))
	};
}
