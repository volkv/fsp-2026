// Publishes the taxonomy release from `taxonomy/` into the database from DATABASE_URL. Runs with plain Node
// (type stripping), without the SvelteKit runtime. Repeating it with unchanged files is a no-op; changed files under
// an already published label are refused.
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { publishTaxonomy } from '../src/lib/server/taxonomy/publish.ts';
import { buildRelease, readTaxonomyDatasets } from '../src/lib/server/taxonomy/release.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error('DATABASE_URL is not set');
}

const release = buildRelease(await readTaxonomyDatasets(fileURLToPath(new URL('../taxonomy', import.meta.url))));
const client = postgres(databaseUrl, {
	max: 1,
	onnotice: (notice) => {
		console.log(`[seed-taxonomy] ${notice.severity}: ${notice.message}`);
	}
});

try {
	const outcome = await publishTaxonomy(client, release);
	console.log(
		`Taxonomy ${outcome.label}: ${outcome.taxonomy} (${outcome.taxonomyVersionId}, sha256 ${outcome.contentSha256}); ` +
			`categorization rule set v${outcome.ruleset.version}: ${outcome.ruleset.outcome}; ` +
			`match rule set v${outcome.matchRuleset.version}: ${outcome.matchRuleset.outcome}`
	);
	if (outcome.ruleset.outcome === 'created' || outcome.matchRuleset.outcome === 'created') {
		// Categories, matches and pools computed on the previous rule sets are recalculated by `derivations.reconcile`,
		// enqueued with the publication, in batches; until then each keeps the rule set it was computed on.
		console.log('New rule sets: derivations.reconcile is enqueued, derived data follows as the worker runs it');
	}
} finally {
	await client.end({ timeout: 5 });
}
