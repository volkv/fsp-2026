import { describe, expect, it } from 'vitest';
import { ageGroup } from '$lib/server/visibility/age';
import { auditOutcome, fourFifths, regionGroup, type CandidateGroups } from './fairness';

const THRESHOLD = 5;

describe('fourFifths', () => {
	it('flags a group selected at less than four fifths of the most selected one', () => {
		const [fsp, noFsp] = fourFifths(
			[
				{ key: 'fsp', eligible: 20, selected: 10 },
				{ key: 'no_fsp', eligible: 40, selected: 12 }
			],
			THRESHOLD
		);
		expect(fsp).toMatchObject({ rate: { exact: 0.5 }, ratio: { exact: 1 }, reference: true, flagged: false });
		expect(noFsp?.rate).toEqual({ exact: 0.3 });
		expect(noFsp?.ratio && 'exact' in noFsp.ratio ? noFsp.ratio.exact : null).toBeCloseTo(0.6);
		expect(noFsp).toMatchObject({ flagged: true, reference: false });
	});

	it('does not flag a group at four fifths exactly', () => {
		const [, second] = fourFifths(
			[
				{ key: 'a', eligible: 10, selected: 10 },
				{ key: 'b', eligible: 10, selected: 8 }
			],
			THRESHOLD
		);
		expect(second).toMatchObject({ ratio: { exact: 0.8 }, flagged: false });
	});

	it('hides every count and the rate of a group smaller than the threshold, zeros included', () => {
		const [small, big] = fourFifths(
			[
				{ key: 'small', eligible: 4, selected: 0 },
				{ key: 'big', eligible: 30, selected: 15 }
			],
			THRESHOLD
		);
		expect(small).toEqual({
			key: 'small',
			eligible: { below: THRESHOLD },
			selected: { below: THRESHOLD },
			rate: null,
			ratio: null,
			flagged: false,
			reference: false
		});
		expect(big).toMatchObject({ eligible: { value: 30 }, selected: { value: 15 }, reference: true });
	});

	it('shows few selected of a large group only as an upper bound, flagged when even the bound is below the bar', () => {
		const [reference, bounded, unsure] = fourFifths(
			[
				{ key: 'reference', eligible: 20, selected: 10 },
				{ key: 'bounded', eligible: 40, selected: 2 },
				{ key: 'unsure', eligible: 10, selected: 3 }
			],
			THRESHOLD
		);
		expect(reference?.reference).toBe(true);
		// 1..4 of 40: the rate is below 4/40 = 0.1, the ratio below 0.2.
		expect(bounded).toMatchObject({ selected: { below: THRESHOLD }, rate: { below: 0.1 }, flagged: true });
		expect(bounded?.ratio && 'below' in bounded.ratio ? bounded.ratio.below : null).toBeCloseTo(0.2);
		// 1..4 of 10: below 0.4 / 0.5 = 0.8 — not below the bar for sure, so not flagged.
		expect(unsure).toMatchObject({ rate: { below: 0.4 }, ratio: { below: 0.8 }, flagged: false });
	});

	it('keeps zero selected of a large group as zero and flags it', () => {
		const [, none] = fourFifths(
			[
				{ key: 'some', eligible: 10, selected: 5 },
				{ key: 'none', eligible: 10, selected: 0 }
			],
			THRESHOLD
		);
		expect(none).toMatchObject({ selected: { value: 0 }, rate: { exact: 0 }, ratio: { exact: 0 }, flagged: true });
	});

	it('has no reference and no ratios when nobody of any shown group was selected', () => {
		const groups = fourFifths(
			[
				{ key: 'a', eligible: 10, selected: 0 },
				{ key: 'b', eligible: 0, selected: 0 }
			],
			THRESHOLD
		);
		expect(groups.map((group) => [group.ratio, group.flagged, group.reference])).toEqual([
			[null, false, false],
			[null, false, false]
		]);
		expect(groups[1]).toMatchObject({ eligible: { value: 0 }, rate: null });
	});
});

describe('auditOutcome', () => {
	const person = (fsp: boolean, synthetic = true): CandidateGroups => ({
		fsp,
		age: '25_34',
		region: 'moscow',
		synthetic
	});

	it('counts each dimension over the same candidates and marks the provenance', () => {
		const facts = new Map<string, CandidateGroups>();
		for (let i = 0; i < 10; i += 1) facts.set(`f${i}`, person(true));
		for (let i = 0; i < 10; i += 1) facts.set(`n${i}`, person(false, i > 0));
		const eligible = new Set(facts.keys());
		const selected = new Set(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const audit = auditOutcome('offer', facts, eligible, selected, THRESHOLD);
		expect(audit.provenance).toBe('mixed');
		const fsp = audit.dimensions.find((d) => d.dimension === 'fsp')?.groups;
		expect(fsp?.map((g) => [g.key, g.rate, g.reference])).toEqual([
			['fsp', { exact: 0.6 }, false],
			['no_fsp', { exact: 0.7 }, true]
		]);
		const age = audit.dimensions.find((d) => d.dimension === 'age')?.groups;
		expect(age?.find((g) => g.key === '25_34')).toMatchObject({ eligible: { value: 20 }, selected: { value: 13 } });
		expect(age?.find((g) => g.key === 'minor')).toMatchObject({ eligible: { value: 0 }, rate: null });
	});

	it('refuses a candidate whose groups are unknown', () => {
		expect(() => auditOutcome('top10', new Map(), new Set(['x']), new Set(), THRESHOLD)).toThrow(/no groups/);
	});
});

describe('groups of a candidate', () => {
	const at = new Date('2026-10-11T12:00:00Z');

	it('puts an adult into the band of full years and a minor into one group', () => {
		const day = (birthDate: string) => ageGroup({ birthDate, precision: 'day', status: 'verified' }, at);
		expect(day('2002-10-11')).toBe('18_24');
		expect(day('2001-10-12')).toBe('18_24');
		expect(day('2001-10-11')).toBe('25_34');
		expect(day('1981-10-12')).toBe('35_44');
		expect(day('1970-01-01')).toBe('45_plus');
		expect(day('2010-05-05')).toBe('minor');
	});

	it('keeps an unknown or conflicting date unknown, and a year that crosses a band boundary unknown', () => {
		expect(ageGroup({ birthDate: null, precision: null, status: 'unknown' }, at)).toBe('unknown');
		expect(ageGroup({ birthDate: '1990-01-01', precision: 'day', status: 'conflict' }, at)).toBe('unknown');
		// Born in 2001: 24 or 25 on 2026-10-11.
		expect(ageGroup({ birthDate: '2001-01-01', precision: 'year', status: 'unverified' }, at)).toBe('unknown');
		expect(ageGroup({ birthDate: '1995-01-01', precision: 'year', status: 'unverified' }, at)).toBe('25_34');
	});

	it('reads the capitals and the rest of the regions', () => {
		expect([regionGroup('RU-MOW'), regionGroup('RU-SPE'), regionGroup('RU-TA'), regionGroup(null)]).toEqual([
			'moscow',
			'saint_petersburg',
			'other',
			'none'
		]);
	});
});
