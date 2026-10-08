// The model side of the demo seed in tests: an adapter the stored mode must never reach, and copies of `seeds/` with the
// stored parses a test needs.
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelParsesFile, StoredParse } from '$lib/server/demo/model-parses';
import type { ModelAdapter } from '$lib/server/ml/adapter';

export function modelsNotCalled(): Pick<ModelAdapter, 'extract' | 'extractModelKey'> {
	throw new Error('the demo seed called the model adapter in the stored mode');
}

/** A copy of `seeds/` whose `model-parses.json` stores these parses: the seed's stored answers under the test's control. */
export async function seedsWithParses(parses: readonly StoredParse[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'demo-seeds-'));
	await cp(fileURLToPath(new URL('../../seeds', import.meta.url)), directory, { recursive: true });
	await writeParses(directory, parses);
	return directory;
}

export async function writeParses(directory: string, parses: readonly StoredParse[]): Promise<void> {
	const file: ModelParsesFile = { description: 'test', parses: [...parses] };
	await writeFile(join(directory, 'model-parses.json'), `${JSON.stringify(file, null, '\t')}\n`);
}
