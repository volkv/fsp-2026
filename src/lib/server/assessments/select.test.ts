import { describe, expect, it } from 'vitest';
import { fixtureFamilies } from '../../../../tests/helpers/families';
import { gradeDefinition } from './contract/catalog';
import { PROCEDURE } from './contract/procedure';
import { attemptDurationMs, attemptForm, chooseForSlot, instanceSeed, seenKey, slotsOf } from './select';

const families = fixtureFamilies('backend').map((f) => f.descriptor);
const junior = families.filter((f) => f.levels.some((l) => l.grade === 'junior'));

describe('plan and slot choice', () => {
	const slots = slotsOf('backend', 'junior');
	const base = { families, grade: 'junior' as const, attemptSeed: 'attempt-1' };
	const grade = { kind: 'grade', form: 'A' } as const;

	it('serves the defining blocks first and the practice at its slot', () => {
		const definition = gradeDefinition('backend', 'junior');
		const first = slots.filter((s) => !s.practice).slice(0, 2 * PROCEDURE.definingMinItems);
		expect(new Set(first.map((s) => s.block))).toEqual(new Set(definition.defining));
		expect(slots.find((s) => s.practice)?.position).toBe(definition.practice.position);
	});

	it('takes a family-level of the slot block and kind, the anchor class first, with the seed of the slot', () => {
		const practice = slots.find((s) => s.practice);
		if (!practice) throw new Error('no practice slot');
		const choice = chooseForSlot({
			...base,
			slot: practice,
			want: grade,
			usedFamilies: new Set(),
			seen: new Set(),
			seq: practice.position
		});
		expect(choice?.family.format).toBe('practice_code');
		expect(choice?.seed).toBe(instanceSeed('attempt-1', practice.position));
		const anchored = junior.find((f) => f.levels.some((l) => l.classes.some((c) => c.form === 'anchor')));
		if (!anchored) throw new Error('no anchor');
		const others = new Set(
			junior.filter((f) => f.block === anchored.block && f.key !== anchored.key).map((f) => f.key)
		);
		const chosen = chooseForSlot({
			...base,
			slot: { block: anchored.block, practice: false },
			want: grade,
			usedFamilies: others,
			seen: new Set(),
			seq: 1
		});
		expect(chosen?.family.key).toBe(anchored.key);
		expect(chosen?.classId).toBe('k');
	});

	it('never serves a used family or a seen class, takes only reserve classes for a block test, and runs out instead', () => {
		const slot = slots[0];
		if (!slot) throw new Error('no slot');
		const inBlock = junior.filter((f) => f.block === slot.block);
		const seen = (classes: string[]) =>
			new Set(inBlock.flatMap((f) => classes.map((c) => seenKey(f.key, 'junior', c))));
		const choose = (
			want: Parameters<typeof chooseForSlot>[0]['want'],
			seenSet: Set<string>,
			used = new Set<string>()
		) => chooseForSlot({ ...base, slot, want, usedFamilies: used, seen: seenSet, seq: 1 });
		expect(choose(grade, seen(['a', 'b', 'k', 'x']))).toBeNull();
		expect(choose(grade, new Set(), new Set(inBlock.map((f) => f.key)))).toBeNull();
		expect(choose(grade, seen(['a', 'k']))).toBeNull();
		expect(choose({ kind: 'grade', form: 'B' }, seen(['a', 'k']))?.classId).toBe('b');
		expect(choose({ kind: 'reserve' }, new Set())?.classId).toBe('x');
		expect(choose({ kind: 'reserve' }, seen(['x']))).toBeNull();
	});

	it('takes the form with fewer seen classes, a tie by the seed', () => {
		const forms = new Set(
			['s1', 's2', 's3', 's4', 's5', 's6'].map((s) => attemptForm(families, 'junior', new Set(), s))
		);
		expect(forms).toEqual(new Set(['A', 'B']));
		const seenA = new Set(junior.slice(0, 3).map((f) => seenKey(f.key, 'junior', 'a')));
		expect(attemptForm(families, 'junior', seenA, 's1')).toBe('B');
		const seenB = new Set(junior.slice(0, 3).map((f) => seenKey(f.key, 'junior', 'b')));
		expect(attemptForm(families, 'junior', seenB, 's1')).toBe('A');
	});

	it('gives the attempt one and a half of the time norms of the longest trajectory', () => {
		const definition = gradeDefinition('backend', 'junior');
		const items = definition.blocks.reduce((sum, b) => sum + b.items, 0);
		expect(attemptDurationMs(families, 'backend', 'junior')).toBe(((items - 1) * 120 + 900) * 1.5 * 1000);
	});
});
