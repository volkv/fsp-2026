// A pseudonym back to its candidate for one company (domain 14). The pseudonym is a keyed hash of the candidate id and
// the company id, so it cannot be reversed: the candidates are hashed for the company and compared. Whether the company
// may see the candidate is decided afterwards by `canShow`, never by the lookup.
import { ne } from 'drizzle-orm';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import { candidates } from '$lib/server/db/schema';

export async function candidateOfPseudonym(
	executor: Executor,
	crypto: Pick<FieldCrypto, 'pseudonym'>,
	companyId: string,
	pseudonym: string
): Promise<string | null> {
	const rows = await executor.select({ id: candidates.id }).from(candidates).where(ne(candidates.status, 'deleted'));
	return rows.find((row) => crypto.pseudonym(row.id, companyId) === pseudonym)?.id ?? null;
}
