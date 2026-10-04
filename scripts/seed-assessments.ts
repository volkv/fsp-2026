// Publishes the assessment bank from `assessments/` into the database from DATABASE_URL. Runs with plain Node (type
// stripping), without the SvelteKit runtime. Repeating it with unchanged files is a no-op; a published version with
// changed files is refused (a change is a new version in the files).
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readAssessmentBank } from '../src/lib/server/assessments/bank.ts';
import { publishAssessmentBank } from '../src/lib/server/assessments/publish.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error('DATABASE_URL is not set');
}

const bank = await readAssessmentBank(fileURLToPath(new URL('../assessments', import.meta.url)));
const client = postgres(databaseUrl, {
	max: 1,
	onnotice: (notice) => {
		console.log(`[seed-assessments] ${notice.severity}: ${notice.message}`);
	}
});

try {
	const outcome = await publishAssessmentBank(client, bank);
	for (const item of outcome.assessments) {
		console.log(`Assessment ${item.key} v${item.version}: ${item.outcome} (${item.assessmentId})`);
	}
	if (outcome.retired.length > 0) console.log(`Retired, no longer in the bank: ${outcome.retired.join(', ')}`);
} finally {
	await client.end({ timeout: 5 });
}
