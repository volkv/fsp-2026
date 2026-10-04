// Publication of the assessment bank (docs/domain.md, section 10.1). A published version is immutable: the same
// version with the same content is a no-op, the same version with other content is refused, and a change is a new
// version in the files. Publishing a version retires the previous one: attempts already started on it keep it, new
// attempts take the new one. An assessment whose files are gone from the bank is retired.
// Imported by plain Node (scripts/seed-assessments.ts): relative imports with extensions, erasable syntax only.
import type postgres from 'postgres';
import { uuidv7 } from '../ids.ts';
import { canonicalJson } from '../json/canonical.ts';
import { AssessmentBankError, type BankEntry } from './bank.ts';

type Executor = postgres.Sql | postgres.TransactionSql;

export interface PublishedAssessment {
	key: string;
	version: number;
	assessmentId: string;
	outcome: 'published' | 'unchanged';
}

export interface BankPublication {
	assessments: PublishedAssessment[];
	/** Keys whose published version was retired because the bank no longer has them. */
	retired: string[];
}

interface StoredVersion {
	assessment_id: string;
	kind: string;
	version: number;
	content_sha256: string;
	status: string;
}

async function storedVersions(tx: Executor, key: string): Promise<StoredVersion[]> {
	return tx<StoredVersion[]>`
		select v.assessment_id, a.kind, v.version, v.content_sha256, v.status
		from assessment_versions v
		join assessments a on a.id = v.assessment_id
		where v.item_bank ->> 'key' = ${key}
		order by v.version
	`;
}

async function publishEntry(tx: Executor, entry: BankEntry): Promise<PublishedAssessment> {
	const versions = await storedVersions(tx, entry.key);
	const latest = versions.at(-1);
	if (latest && latest.version > entry.version) {
		throw new AssessmentBankError(
			'version_regressed',
			`assessment ${entry.key} has v${latest.version} published; the files declare v${entry.version}`
		);
	}
	const same = versions.find((stored) => stored.version === entry.version);
	if (same) {
		if (same.content_sha256 !== entry.contentSha256) {
			throw new AssessmentBankError(
				'version_changed',
				`assessment ${entry.key} v${entry.version} is already published with other content ` +
					`(stored ${same.content_sha256}, files ${entry.contentSha256}); a change needs a new version`
			);
		}
		return { key: entry.key, version: entry.version, assessmentId: same.assessment_id, outcome: 'unchanged' };
	}
	if (latest && latest.kind !== entry.kind) {
		throw new AssessmentBankError(
			'kind_changed',
			`assessment ${entry.key} is a ${latest.kind}, the files declare ${entry.kind}`
		);
	}

	let assessmentId: string;
	if (latest) {
		assessmentId = latest.assessment_id;
		await tx`
			update assessments set title = ${entry.title}, skill_keys = ${entry.skillKeys}, updated_at = now()
			where id = ${assessmentId}
		`;
		await tx`
			update assessment_versions set status = 'retired', updated_at = now()
			where assessment_id = ${assessmentId} and status = 'published'
		`;
	} else {
		assessmentId = uuidv7();
		await tx`
			insert into assessments (id, kind, title, skill_keys)
			values (${assessmentId}, ${entry.kind}, ${entry.title}, ${entry.skillKeys})
		`;
	}
	await tx`
		insert into assessment_versions
			(id, assessment_id, version, content_sha256, scorer, level_scale, coverage, item_bank, status)
		values (
			${uuidv7()}, ${assessmentId}, ${entry.version}, ${entry.contentSha256},
			${canonicalJson(entry.scorer)}::text::jsonb, ${canonicalJson(entry.levelScale)}::text::jsonb,
			${canonicalJson(entry.coverage)}::text::jsonb, ${canonicalJson(entry.itemBank)}::text::jsonb,
			'published'
		)
	`;
	return { key: entry.key, version: entry.version, assessmentId, outcome: 'published' };
}

/** Publishes the bank in one transaction under an advisory lock; concurrent starts publish once. */
export async function publishAssessmentBank(sql: postgres.Sql, bank: BankEntry[]): Promise<BankPublication> {
	return sql.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended('assessments.publish', 0))`;
		const assessments: PublishedAssessment[] = [];
		for (const entry of bank) assessments.push(await publishEntry(tx, entry));

		const keys = bank.map((entry) => entry.key);
		const gone = await tx<{ key: string }[]>`
			update assessment_versions set status = 'retired', updated_at = now()
			where status = 'published' and not (item_bank ->> 'key' = any(${keys}))
			returning item_bank ->> 'key' as key
		`;
		return { assessments, retired: gone.map((row) => row.key).sort() };
	});
}
