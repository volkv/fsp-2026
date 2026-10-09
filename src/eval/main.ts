// Entry point of the evaluation bridge (`node --env-file=.env .eval-build/main.js < request.json`): one request on stdin,
// one JSON answer on stdout, exit code 0. A failed command prints its error on stderr and exits with 1; the harness
// stops the run instead of recording partial numbers. Built by bundle.config.ts next to this file.
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { closeDb, db } from '$lib/server/db';
import { docparse } from '$lib/server/documents/docparse';
import { modelAdapter, modelModes } from '$lib/server/ml';
import { ModelAdapter } from '$lib/server/ml/adapter';
import { databaseSpaceLookup } from '$lib/server/ml/spaces';
import { closeRedis } from '$lib/server/redis';
import { objectStore } from '$lib/server/storage/object-store';
import { handle } from './bridge';
import type { CatalogEmbedder } from './rank';
import { loadEvalTaxonomy } from './taxonomy';
import { loggedError } from '$lib/server/db/errors';

/** The checkout relative to this bundle, set by the build (bundle.config.ts). */
declare const __EVAL_CHECKOUT_DIR__: string;
const inCheckout = (path: string) => fileURLToPath(new URL(`${__EVAL_CHECKOUT_DIR__}${path}`, import.meta.url));

/** The configured embedder for a catalog of `rank`: spaces are looked up in the catalog's database. */
function catalogEmbedder(): CatalogEmbedder | null {
	const { models } = config();
	if (models.embed === null) return null;
	return {
		config: models.embed,
		models: (catalog) => new ModelAdapter({ models, modes: modelModes(), spaces: databaseSpaceLookup(() => catalog) })
	};
}

async function main(): Promise<void> {
	const input = await text(process.stdin);
	const answer = await handle(JSON.parse(input), {
		taxonomy: () => loadEvalTaxonomy(inCheckout('taxonomy/')),
		docparse,
		adapter: modelAdapter,
		record: () => ({ db: db(), store: objectStore(), crypto: fieldCrypto() }),
		rank: () => ({
			databaseUrl: config().databaseUrl,
			migrationsDir: inCheckout('src/lib/server/db/migrations/'),
			taxonomyDir: inCheckout('taxonomy/'),
			models: modelAdapter(),
			embed: catalogEmbedder()
		}),
		build: { version: __APP_VERSION__, commit: __APP_COMMIT__ }
	});
	process.stdout.write(`${JSON.stringify(answer)}\n`);
}

main()
	.then(async () => {
		closeRedis();
		await closeDb();
	})
	.catch((error: unknown) => {
		console.error('[eval-bridge]', loggedError(error));
		process.exitCode = 1;
		closeRedis();
		return closeDb();
	});
