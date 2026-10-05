// What a stored trajectory report was made with besides the content of the bank: the code of the simulation. The report
// is a function of the content, the catalog, the procedure and this code (`simulate.ts` and every module it imports,
// the contract included); the hash of their texts tells a report still valid from one the code has moved past.
//
// Plain erasable TypeScript without `$lib`: read by the release script under bare Node, from the source tree.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('./simulate.ts', import.meta.url));
const ROOT = dirname(ENTRY);

/** Relative imports of a module's text: `from './x.ts'`, `import './x.ts'`. */
function localImports(text: string): string[] {
	return [...text.matchAll(/(?:from|import)\s+'(\.{1,2}\/[^']+)'/gu)].map((m) => m[1] as string);
}

/** `simulate.ts` and the modules it reaches by relative imports, as paths relative to this directory, sorted. */
export async function simulationModules(): Promise<{ path: string; text: string }[]> {
	const seen = new Map<string, string>();
	const queue = [ENTRY];
	while (queue.length > 0) {
		const path = queue.pop() as string;
		if (seen.has(path)) continue;
		const text = await readFile(path, 'utf8');
		seen.set(path, text);
		for (const spec of localImports(text)) queue.push(resolve(dirname(path), spec));
	}
	return [...seen]
		.map(([path, text]) => ({ path: relative(ROOT, path), text }))
		.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** SHA-256 of the simulation code: every module path and text. */
export async function simulationSha256(): Promise<string> {
	const hash = createHash('sha256');
	for (const { path, text } of await simulationModules()) hash.update(`${path}\0${text}\0`);
	return hash.digest('hex');
}
