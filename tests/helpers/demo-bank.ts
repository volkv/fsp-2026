// The bank tree released ahead of its judgements, for the tests of the demo seed: the families of `assessments/families`
// with the stored trajectory report, released whatever the acceptance of the bank says (pending Angoff ratings and
// rubric reviews, the operating characteristic): what these tests check is the seed's path, not the bank. The seed takes
// tests only in a released specialization; this stands for the release the stand gets once the bank is accepted.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpecializationKey } from '../../src/lib/server/assessments/contract/catalog';
import type { TrajectoryReport } from '../../src/lib/server/assessments/contract/validate';
import { loadBankTree } from '../../src/lib/server/assessments/families';
import { assembleRelease } from '../../src/lib/server/assessments/release';
import type { Database } from '../../src/lib/server/db';
import { bankReleases } from '../../src/lib/server/db/schema';
import { BANK_TREE, TRAJECTORY_DIR } from '../../scripts/release-bank';

export async function releaseBankAhead(db: Database, specialization: SpecializationKey): Promise<string> {
	const bank = (await loadBankTree(BANK_TREE)).get(specialization);
	if (!bank) throw new Error(`the bank tree has no ${specialization}`);
	const stored = JSON.parse(await readFile(join(TRAJECTORY_DIR, `${specialization}.json`), 'utf8')) as {
		report: TrajectoryReport;
	};
	const assembled = assembleRelease(specialization, bank.families, bank.sharedSha256, 1, {
		trajectories: stored.report
	});
	await db.insert(bankReleases).values({
		id: assembled.release.id,
		specialization,
		catalogVersion: assembled.release.catalogVersion,
		procedureVersion: assembled.release.procedureVersion,
		contentSha256: assembled.contentSha256,
		sharedSha256: bank.sharedSha256,
		manifest: assembled.manifest,
		status: 'released',
		releasedAt: new Date()
	});
	return assembled.release.id;
}
