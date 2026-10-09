import { describe, expect, it } from 'vitest';
import { fixtureFamilies } from '../../../../tests/helpers/families';
import { BANK_ROOT } from './bank-store';
import { blockTestServable } from './block-test';
import type { FamilyDescriptor } from './contract/bank';
import type { SpecializationKey } from './contract/catalog';
import { loadSpecializationFamilies } from './families';
import { attemptForm, chooseForSlot, slotsOf } from './select';
import {
	blockSampleChoices,
	gradeSampleChoices,
	vacancyTestSpec,
	type PairPlan,
	type SpecInput,
	type SpecRequirement
} from './vacancy-spec';

const loaded = {
	backend: fixtureFamilies('backend'),
	qa: fixtureFamilies('qa')
};
const banks = new Map<SpecializationKey, readonly FamilyDescriptor[]>([
	['backend', loaded.backend.map((f) => f.descriptor)],
	['qa', loaded.qa.map((f) => f.descriptor)]
]);

const skill = (skillKey: string, requirement: 'required' | 'nice' = 'required'): SpecRequirement => ({
	skillKey,
	name: skillKey,
	requirement
});

const middleBackend: SpecInput = {
	specializations: ['backend'],
	grades: ['middle'],
	requirements: [
		skill('sql'),
		skill('rest'),
		skill('python'),
		skill('oop'),
		skill('system_design'),
		skill('manual_testing'),
		skill('kafka'),
		{ skillKey: null, name: 'Hugging Face', requirement: 'required' },
		skill('algorithms', 'nice')
	],
	seed: 'vacancy:v1:1'
};

function openPlan(plan: PairPlan | undefined) {
	if (plan?.status !== 'open') throw new Error('the pair has no open plan');
	return plan;
}

describe('specification of the test of a vacancy', () => {
	it('shows on the bank of the product the set the vacancy seeds, the same every time', async () => {
		const backend = (await loadSpecializationFamilies(BANK_ROOT, 'backend')).map((f) => f.descriptor);
		const real = new Map<SpecializationKey, readonly FamilyDescriptor[]>([['backend', backend]]);
		const plan = openPlan(vacancyTestSpec(middleBackend, real).plans[0]);
		expect(openPlan(vacancyTestSpec(middleBackend, real).plans[0])).toEqual(plan);
		const { form, choices } = gradeSampleChoices(backend, 'backend', 'middle', `${middleBackend.seed}:backend:middle`);
		expect(plan.base.form).toBe(form);
		expect(plan.base.sample.map((s) => [s.position, s.block, s.format, s.timeNormSec])).toEqual(
			choices.map((c, i) => [i + 1, c?.family.block, c?.family.format, c?.level.timeNormSec])
		);
		// Another text seeds another set: the seed is what the example rests on.
		const other = openPlan(vacancyTestSpec({ ...middleBackend, seed: 'text:other' }, real).plans[0]);
		expect(other.base.sample).not.toEqual(plan.base.sample);
	});

	it('draws the example set by the choice the engine serves: grade slots and block-test clusters', () => {
		const families = banks.get('backend') ?? [];
		const seed = 'sample-seed';
		const form = attemptForm(families, 'middle', new Set(), null, seed);
		const used = new Set<string>();
		const replay = slotsOf('backend', 'middle').map((slot, index) => {
			const choice = chooseForSlot({
				families,
				grade: 'middle',
				slot,
				want: { kind: 'grade', form },
				usedFamilies: used,
				seen: new Set(),
				attemptSeed: seed,
				seq: index + 1
			});
			if (choice) used.add(choice.family.key);
			return choice && [choice.family.key, choice.classId, choice.seed];
		});
		const sample = gradeSampleChoices(families, 'backend', 'middle', seed);
		expect(sample.form).toBe(form);
		expect(sample.choices.map((c) => c && [c.family.key, c.classId, c.seed])).toEqual(replay);
		expect(new Set(replay.map((c) => c?.[0])).size).toBe(replay.length);

		const block = blockSampleChoices(families, 'middle', 'be.api', seed);
		expect(block).toHaveLength(4);
		expect(block.every((c) => c !== null && c.family.block === 'be.api')).toBe(true);
		expect(new Set(block.map((c) => c?.family.key)).size).toBe(4);
		expect(blockTestServable(families, 'middle', 'be.api', new Set(), seed)).toBe(true);
	});

	it('adds a block test for a required skill of an allowed pair and names what the test does not check', () => {
		const plan = openPlan(vacancyTestSpec(middleBackend, banks).plans[0]);
		const by = Object.fromEntries(plan.requirements.map((r) => [r.name, r]));
		expect(by.sql?.coverage).toMatchObject({ kind: 'base_stack', block: 'be.db' });
		expect(by.python?.coverage).toEqual({ kind: 'base_practice' });
		expect(by.rest?.coverage).toMatchObject({ kind: 'vacancy_block', block: 'be.api' });
		// be.lang has two items at Middle, be.design is not in its plan: no block test at this grade.
		expect(by.oop?.coverage).toMatchObject({ kind: 'not_at_grade', block: 'be.lang', itemsInPlan: 2 });
		expect(by.system_design?.coverage).toMatchObject({ kind: 'not_at_grade', block: 'be.design', itemsInPlan: 0 });
		expect(by.manual_testing?.coverage).toMatchObject({ kind: 'other_specialization', specialization: 'qa' });
		expect(by.kafka?.coverage).toEqual({ kind: 'not_tested', reason: 'no_block' });
		expect(by['Hugging Face']?.coverage).toEqual({ kind: 'not_tested', reason: 'outside_taxonomy' });
		expect(by.algorithms?.coverage).toMatchObject({ kind: 'not_at_grade', block: 'be.algo', itemsInPlan: 2 });
		expect(plan.requirements.filter((r) => r.tested).map((r) => r.name)).toEqual(['sql', 'rest', 'python']);
		expect(plan.vacancyBlocks.map((b) => [b.block, b.skillKeys, b.clusters, b.servable])).toEqual([
			['be.api', ['rest'], 4, true]
		]);
		expect(plan.base.blocks.filter((b) => b.defining).map((b) => b.block)).toEqual(['be.db', 'be.concurrency']);
		expect(plan.base.sample).toHaveLength(plan.base.longestSlots);

		// A nice-to-have skill of an allowed pair (be.algo has three items at Junior) is no block of the vacancy.
		const junior = openPlan(vacancyTestSpec({ ...middleBackend, grades: ['junior'] }, banks).plans[0]);
		expect(junior.requirements.find((r) => r.name === 'algorithms')?.coverage).toMatchObject({
			kind: 'block_on_request',
			block: 'be.algo'
		});
		expect(junior.vacancyBlocks.map((b) => b.block)).not.toContain('be.algo');
	});

	it('shows blocks and kinds of items only: no family, class, seed or condition of an item', () => {
		const spec = vacancyTestSpec(middleBackend, banks);
		const json = JSON.stringify(spec);
		const plan = openPlan(spec.plans[0]);
		const modules = new Map(loaded.backend.map((f) => [f.descriptor.key, f.module]));
		const seed = `${middleBackend.seed}:backend:middle`;
		const choices = [
			...gradeSampleChoices(banks.get('backend') ?? [], 'backend', 'middle', seed).choices,
			...blockSampleChoices(banks.get('backend') ?? [], 'middle', 'be.api', `${seed}:be.api`)
		];
		expect(choices.length).toBe(plan.base.longestSlots + 4);
		for (const choice of choices) {
			if (!choice) throw new Error('a slot of the example is not served');
			const instance = modules
				.get(choice.family.key)
				?.generate({ seed: choice.seed, grade: 'middle', classId: choice.classId });
			if (!instance) throw new Error(`no generator of ${choice.family.key}`);
			expect(json).not.toContain(choice.family.key);
			expect(json).not.toContain(choice.seed);
			expect(json).not.toContain(`"${choice.classId}"`);
			expect(json).not.toContain(instance.statement.markdown);
		}
	});

	it('names a specialization without a released bank closed and a vacancy without a pair of the catalog', () => {
		const spec = vacancyTestSpec(
			{ specializations: ['devops', 'frontend'], grades: ['junior'], requirements: [skill('docker')], seed: 's' },
			banks
		);
		expect(spec.plans.map((p) => [p.specialization, p.status, p.status === 'closed' ? p.reason : null])).toEqual([
			['devops', 'closed', 'not_released'],
			['frontend', 'closed', 'not_released']
		]);
		const lead = vacancyTestSpec(
			{ specializations: [], grades: ['lead'], requirements: [skill('sql')], seed: 's' },
			banks
		);
		expect(lead.gaps).toEqual(['no_specialization', 'no_grade']);
		expect(lead.requirements.map((r) => [r.coverage.kind, r.tested])).toEqual([['other_specialization', false]]);
	});
});
