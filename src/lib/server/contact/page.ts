// What the cabinet pages of contact — requests of a confirmation, calls of companies, applications — work with: the
// configured database, field crypto and clock; and the names of the catalog the pages show.
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import type { ApplicationDeps } from '$lib/server/applications/service';
import type { ChallengeDeps } from '$lib/server/challenges/company';
import type { ConfirmationDeps } from '$lib/server/confirmations/requests';

export function contactPageDeps(): ConfirmationDeps & ChallengeDeps & ApplicationDeps {
	return { db: db(), crypto: fieldCrypto(), now: () => new Date() };
}

/** Titles of the specializations, the grades and the blocks of the catalog. */
export function catalogNames() {
	return {
		specializations: Object.fromEntries(CATALOG.specializations.map((s) => [s.key, s.title])),
		grades: Object.fromEntries(CATALOG.grades.map((g) => [g.key, g.title])),
		blocks: Object.fromEntries(CATALOG.blocks.map((b) => [b.code, b.title]))
	};
}
