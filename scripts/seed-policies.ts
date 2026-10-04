// Publishes the product policies from `policies/` (docs/domain.md, section 13.8) and registers the vacancy sources of
// the catalog (section 13.2) in the database from DATABASE_URL. Runs with plain Node (type stripping), without the
// SvelteKit runtime. A policy version is immutable: a published version with the same parameters is left as it is, one
// with other parameters is refused (a change is a new version in the file). Sources are added disabled.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { z } from 'zod';
import { parsePolicyParams, POLICY_KINDS, type PolicyKind } from '../src/lib/server/consent/kinds.ts';
import { uuidv7 } from '../src/lib/server/ids.ts';
import { registerVacancySources } from '../src/lib/server/vacancies/sources/definitions.ts';

/** Why a parameter has its value: a reference to the model, or `product_default` — a product decision of our own. */
const basisSchema = z.string().min(1);

const versionSchema = z.strictObject({
	version: z.int().positive(),
	effective_from: z.iso.datetime({ offset: true }),
	params: z.record(z.string(), z.json()),
	basis: z.record(z.string(), basisSchema)
});

const policyFileSchema = z.strictObject({
	kind: z.enum(POLICY_KINDS),
	/** Sections of the model that define the policy. */
	source: z.string().min(1),
	versions: z.array(versionSchema).min(1)
});

export interface PolicyVersion {
	kind: PolicyKind;
	version: number;
	effectiveFrom: Date;
	params: z.infer<typeof versionSchema>['params'];
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const left = Object.keys(a).sort();
	const right = Object.keys(b).sort();
	return left.length === right.length && left.every((key, i) => key === right[i]);
}

/**
 * Reads every `<kind>.json` of the directory: the parameters of each version are checked against the schema of the
 * kind, every parameter has its basis, versions grow and do not take effect earlier than the previous one.
 */
export async function readPolicyRelease(directory: string): Promise<PolicyVersion[]> {
	const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
	if (names.length === 0) throw new Error(`${directory} has no policies`);
	const release: PolicyVersion[] = [];
	for (const name of names) {
		const file = policyFileSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
		if (basename(name, '.json') !== file.kind) throw new Error(`${name} describes ${file.kind}`);
		let previous: { version: number; effectiveFrom: Date } | null = null;
		for (const entry of file.versions) {
			const where = `${file.kind} v${entry.version}`;
			parsePolicyParams(file.kind, entry.params);
			if (!sameKeys(entry.params, entry.basis))
				throw new Error(`${where}: every parameter needs its basis, and only it`);
			const effectiveFrom = new Date(entry.effective_from);
			if (previous && entry.version !== previous.version + 1) throw new Error(`${where}: versions go one by one`);
			if (!previous && entry.version !== 1) throw new Error(`${where}: the first version is 1`);
			if (previous && effectiveFrom < previous.effectiveFrom) {
				throw new Error(`${where}: takes effect before the previous version`);
			}
			release.push({ kind: file.kind, version: entry.version, effectiveFrom, params: entry.params });
			previous = { version: entry.version, effectiveFrom };
		}
	}
	return release;
}

export interface PublishedPolicy {
	kind: PolicyKind;
	version: number;
	outcome: 'published' | 'unchanged';
}

/** Publishes the release in one transaction under an advisory lock; concurrent starts publish once. */
export async function publishPolicies(client: postgres.Sql, release: PolicyVersion[]): Promise<PublishedPolicy[]> {
	return client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended('policies.publish', 0))`;
		const outcomes: PublishedPolicy[] = [];
		for (const policy of release) {
			const params = JSON.stringify(policy.params);
			const [existing] = await tx<{ same: boolean }[]>`
				select params = ${params}::text::jsonb and effective_from = ${policy.effectiveFrom} as same
				from product_policies
				where kind = ${policy.kind} and version = ${policy.version}`;
			if (existing) {
				if (!existing.same) {
					throw new Error(
						`${policy.kind} v${policy.version} is published with other parameters: a change is a new version`
					);
				}
				outcomes.push({ kind: policy.kind, version: policy.version, outcome: 'unchanged' });
				continue;
			}
			await tx`
				insert into product_policies (id, kind, version, params, effective_from)
				values (${uuidv7()}, ${policy.kind}, ${policy.version}, ${params}::text::jsonb, ${policy.effectiveFrom})`;
			outcomes.push({ kind: policy.kind, version: policy.version, outcome: 'published' });
		}
		return outcomes;
	});
}

if (import.meta.main) {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('DATABASE_URL is not set');
	const release = await readPolicyRelease(fileURLToPath(new URL('../policies', import.meta.url)));
	const client = postgres(databaseUrl, {
		max: 1,
		onnotice: (notice) => {
			console.log(`[seed-policies] ${notice.severity}: ${notice.message}`);
		}
	});
	try {
		const policies = await publishPolicies(client, release);
		console.log(`Product policies: ${policies.map((p) => `${p.kind} v${p.version} ${p.outcome}`).join(', ')}`);
		const sources = await registerVacancySources(client);
		console.log(
			`Vacancy sources: ${sources.map((s) => `${s.key} ${s.outcome} ${s.enabled ? 'enabled' : 'disabled'}`).join(', ')}`
		);
	} finally {
		await client.end({ timeout: 5 });
	}
}
