import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sharedCodeSha256 } from './families';
import { relativeImports, sharedClosureSha256, sharedImportClosure } from './shared-code';

describe('shared code of the generators', () => {
	let root: string;
	const generator = (key: string): string => join(root, 'backend', key, 'generator.ts');

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'bank-shared-'));
		await mkdir(join(root, '_lib'));
		await mkdir(join(root, 'backend', 'be.x.one'), { recursive: true });
		await mkdir(join(root, 'backend', 'be.x.two'), { recursive: true });
		await writeFile(
			join(root, '_lib', 'family.ts'),
			"import { Rng } from './rng.ts';\nexport const make = () => new Rng();\n"
		);
		await writeFile(join(root, '_lib', 'rng.ts'), 'export class Rng {}\n');
		await writeFile(join(root, '_lib', 'sql.ts'), 'export const sql = 1;\n');
		await writeFile(
			generator('be.x.one'),
			"import {\n\tmake\n} from '../../_lib/family.ts';\nimport type { Rng } from '../../_lib/rng.ts';\nexport const generate = make;\n"
		);
		await writeFile(
			generator('be.x.two'),
			"import { sql } from '../../_lib/sql.ts';\nexport const generate = () => sql;\n"
		);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('reads relative imports, re-exports and side-effect imports, not package or node imports', () => {
		expect(
			relativeImports(
				"import { a } from './a.ts';\nimport type { B } from '../b.ts';\nexport { c } from './c.ts';\nimport './d.ts';\nimport { e } from 'node:fs';\nconst text = `import('./x')`;"
			)
		).toEqual(['./a.ts', '../b.ts', './c.ts', './d.ts']);
	});

	it('follows imports through shared files', () => {
		expect(sharedImportClosure(root, [generator('be.x.one')])).toEqual(['_lib/family.ts', '_lib/rng.ts']);
		expect(sharedImportClosure(root, [generator('be.x.one'), generator('be.x.two')])).toEqual([
			'_lib/family.ts',
			'_lib/rng.ts',
			'_lib/sql.ts'
		]);
	});

	it('does not change when shared code nobody imports is added; changes when imported code changes', async () => {
		const record = sharedClosureSha256(root, [generator('be.x.one')]);
		const release = await sharedCodeSha256(root, 'backend');
		await writeFile(join(root, '_lib', 'shell.ts'), 'export const bash = 1;\n');
		expect(sharedClosureSha256(root, [generator('be.x.one')])).toBe(record);
		expect(await sharedCodeSha256(root, 'backend')).toBe(release);

		// sql.ts is imported by the specialization, not by be.x.one: the release moves, the record of be.x.one does not.
		await writeFile(join(root, '_lib', 'sql.ts'), 'export const sql = 2;\n');
		expect(sharedClosureSha256(root, [generator('be.x.one')])).toBe(record);
		const afterSql = await sharedCodeSha256(root, 'backend');
		expect(afterSql).not.toBe(release);

		// rng.ts is reached only through family.ts: a change of it still makes both stale.
		await writeFile(join(root, '_lib', 'rng.ts'), 'export class Rng { n = 1; }\n');
		expect(sharedClosureSha256(root, [generator('be.x.one')])).not.toBe(record);
		expect(await sharedCodeSha256(root, 'backend')).not.toBe(afterSql);
	});

	it('refuses an import of a missing file', async () => {
		await writeFile(generator('be.x.two'), "import { gone } from '../../_lib/gone.ts';\n");
		expect(() => sharedImportClosure(root, [generator('be.x.two')])).toThrow(/does not exist/);
	});
});
