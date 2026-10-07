// The shared code a generator depends on: the files of the bank's `_*` directories it imports, directly or through other
// shared files. Hashing this closure instead of every shared file keeps a family's gate record and a specialization's
// release valid when the bank gains shared code they never import (another specialization's helpers), and still makes
// them stale on any change of code they do run.
//
// Imports are read from the text: static `import … from '…'`, `export … from '…'` and side-effect `import '…'` with a
// relative specifier. Generators and shared code import nothing else relative (no dynamic `import()` of local files); a
// relative import of a missing file in the bank is an error. Imports out of the bank (the contract under `src/`) are not shared code:
// the contract is versioned on its own (catalog and procedure versions), as before.
//
// Plain erasable TypeScript without `$lib`: the release script and the gate script run it with bare Node.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SPECIFIER = /(?:^|[;\s])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

/** The relative specifiers a TypeScript file imports or re-exports. */
export function relativeImports(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(SPECIFIER)) {
		const specifier = match[1] ?? '';
		if (specifier.startsWith('./') || specifier.startsWith('../')) found.add(specifier);
	}
	return [...found];
}

/** Whether a path (relative to the tree's root) lies in a shared directory: one of its directories starts with `_`. */
function isShared(path: string): boolean {
	return path
		.split(sep)
		.slice(0, -1)
		.some((part) => part.startsWith('_'));
}

/**
 * The shared files (paths relative to `root`, sorted) the given files import, transitively. The entry files themselves
 * are not in the result unless another entry imports them through shared code.
 */
export function sharedImportClosure(root: string, entries: readonly string[]): string[] {
	const closure = new Set<string>();
	const queue = [...entries];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (visited.has(file)) continue;
		visited.add(file);
		for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
			const target = resolve(dirname(file), specifier);
			const path = relative(root, target);
			if (path.startsWith('..') || isAbsolute(path)) continue;
			if (!existsSync(target)) throw new Error(`${file} imports ${specifier}, which does not exist`);
			if (!isShared(path)) continue;
			closure.add(path);
			queue.push(target);
		}
	}
	return [...closure].sort();
}

/** SHA-256 of shared files by path and content; no files — the hash of nothing. */
export function sharedFilesSha256(root: string, paths: readonly string[]): string {
	const hash = createHash('sha256');
	for (const path of [...paths].sort())
		hash
			.update(`${path}\0`)
			.update(readFileSync(resolve(root, path)))
			.update('\0');
	return hash.digest('hex');
}

/** SHA-256 of the shared code the given generators run: their import closure in the bank's `_*` directories. */
export function sharedClosureSha256(root: string, generators: readonly string[]): string {
	return sharedFilesSha256(root, sharedImportClosure(root, generators));
}
