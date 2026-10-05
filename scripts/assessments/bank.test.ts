// The bank tree against its gate records and the contract: every family passed the gates with its current source,
// the descriptors pass the validator (reviews and ratings aside — they are judgements, not properties of code), the
// generators export the contract's functions, are deterministic and build valid instances, and the release of every
// specialization in the tree serves every extreme trajectory. Probes (`_probes/`) are checked, never released.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capacityChecks, type BankRelease, type ItemInstance } from '../../src/lib/server/assessments/contract/bank.ts';
import { CATALOG } from '../../src/lib/server/assessments/contract/catalog.ts';
import { PROCEDURE } from '../../src/lib/server/assessments/contract/procedure.ts';
import { familyProblems, instanceProblems } from '../../src/lib/server/assessments/contract/validate.ts';
import {
	currentSourceSha256,
	gateSourceSha256,
	GENERATOR_FILE,
	loadTree,
	readGateSources,
	sharedSha256
} from './tree.ts';

const { families: tree, problems: treeProblems } = loadTree();
const sources = readGateSources();

interface ContractModule {
	generate?: (input: { seed: string; grade: string; classId: string }) => ItemInstance;
	harness?: (instance: ItemInstance, mode: 'reference' | 'mutants') => { language: string; source: string };
}

describe('the bank tree', () => {
	it('holds families, every directory with a readable descriptor of its own key', () => {
		expect(treeProblems).toEqual([]);
		expect(tree.filter((f) => !f.probe).length).toBeGreaterThan(0);
	});

	it('records a passed gate run for the current source of every family, and nothing else', () => {
		const stale = tree.filter((f) => sources[f.key] !== gateSourceSha256(f)).map((f) => f.key);
		expect(stale).toEqual([]);
		expect(Object.keys(sources).filter((key) => !tree.some((f) => f.key === key))).toEqual([]);
	});

	it('admits every family by the validator of the contract, apart from what waits for reviewers and raters', () => {
		const problems = tree.flatMap((f) =>
			familyProblems(f.descriptor, currentSourceSha256(f)).filter((p) => p.code === 'defect')
		);
		expect(problems).toEqual([]);
	});

	// Builds every class of every level of every family of the bank twice, and both harnesses of QA practice: about 3 s
	// for Backend and QA (105 families) on an idle machine, growing linearly with the bank — six specializations take
	// about 10 s, and a machine loaded by parallel checks makes it four to five times slower. Hence its own timeout.
	it(
		'exports a deterministic generate() with valid instances on every level and class, and harness() for QA',
		{ timeout: 90_000 },
		async () => {
			const problems: string[] = [];
			for (const family of tree) {
				const module = (await import(pathToFileURL(join(family.dir, GENERATOR_FILE)).href)) as ContractModule;
				const generate = module.generate;
				if (!generate) {
					problems.push(`${family.key}: no generate()`);
					continue;
				}
				for (const level of family.descriptor.levels) {
					for (const cls of level.classes) {
						const input = { seed: 'a1b2c3', grade: level.grade, classId: cls.id };
						const instance = generate(input);
						if (JSON.stringify(generate(input)) !== JSON.stringify(instance))
							problems.push(`${family.key}@${level.grade}/${cls.id}: not deterministic`);
						problems.push(...instanceProblems(instance, family.descriptor).map((p) => p.message));
						if (family.descriptor.format === 'qa_mutation') {
							if (!module.harness) problems.push(`${family.key}: QA without harness()`);
							else if (module.harness(instance, 'mutants').source === module.harness(instance, 'reference').source)
								problems.push(`${family.key}: one harness for both modes`);
						}
					}
				}
			}
			expect(problems).toEqual([]);
		}
	);

	it('serves every extreme trajectory of every grade from the release of each specialization', () => {
		const specializations = [...new Set(tree.filter((f) => !f.probe).map((f) => f.specialization))];
		const short: string[] = [];
		for (const specialization of specializations) {
			const release: BankRelease = {
				id: `${specialization}@${CATALOG.version}-1`,
				specialization,
				catalogVersion: CATALOG.version,
				procedureVersion: PROCEDURE.version,
				families: tree.filter((f) => !f.probe && f.specialization === specialization).map((f) => f.descriptor),
				sharedSha256: sharedSha256(),
				familySources: Object.fromEntries(
					tree
						.filter((f) => !f.probe && f.specialization === specialization)
						.map((f) => [f.key, currentSourceSha256(f)])
				)
			};
			for (const c of capacityChecks(release, PROCEDURE).filter((check) => !check.ok))
				short.push(`${specialization} ${c.grade} ${c.scenario.join('→')}`);
		}
		expect(short).toEqual([]);
	});
});
