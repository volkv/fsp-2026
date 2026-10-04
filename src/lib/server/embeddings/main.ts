// Command line of the embedding space (`node build/embeddings/main.js ensure`, built by bundle.config.ts next to this
// file), run by the application image at every start: registers the space of `EMBED_SPACE_ID` from its definition and
// enqueues `embedding.reindex` for the worker (space.ts). Without a configured embedder it does nothing; a space id the
// product does not know, a model that does not produce it, or a registered row that differs from its definition stop
// the start.
import { config } from '$lib/server/config';
import { closeDb, db } from '$lib/server/db';
import { createLogger } from '$lib/server/jobs/log';
import { ensureEmbeddingSpace } from './space';

const log = createLogger({ component: 'embeddings' });

async function main(): Promise<void> {
	const [command] = process.argv.slice(2);
	if (command !== 'ensure') throw new Error(`unknown command «${command ?? ''}»: ensure`);
	const outcome = await ensureEmbeddingSpace(db(), config().models.embed);
	if (outcome.status === 'not_configured') {
		log.info('embedding is not configured: search runs in the FTS-only mode');
		return;
	}
	log.info('embedding space ensured', { space: outcome.spaceId, status: outcome.status, reindex: outcome.reindex });
}

main()
	.then(() => closeDb())
	.catch(async (error: unknown) => {
		log.error('embedding space command failed', {}, error);
		await closeDb();
		process.exitCode = 1;
	});
