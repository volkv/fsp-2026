// Length of experience (docs/domain.md 9.5): the union of the periods of experience entries, not their sum, so parallel
// jobs merge. A period known only to the year gives a range: the shortest and the longest reading are unioned separately.
import type { ExperienceInput, ExperienceSummary, MonthsRange } from './types';

type Interval = readonly [start: number, end: number];

/** Month index of an ISO date (`YYYY-MM-DD`): months since year 0. */
function monthIndex(isoDate: string): number {
	const year = Number(isoDate.slice(0, 4));
	const month = Number(isoDate.slice(5, 7));
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
		throw new Error(`not an ISO date: ${isoDate}`);
	}
	return year * 12 + month - 1;
}

/** The shortest and the longest reading of an entry's period as half-open month intervals, capped at `as_of`. */
function readings(entry: ExperienceInput, asOf: Date): { short: Interval; long: Interval } {
	const { periodFrom, periodFromPrecision, periodTo, periodToPrecision } = entry;
	if (periodFrom === null || periodFromPrecision === null) {
		throw new Error(`experience entry ${entry.id} is valid without a start`);
	}
	const now = monthIndex(asOf.toISOString()) + 1;
	const from = monthIndex(periodFrom);
	const fromYear = Math.floor(from / 12) * 12;
	// «Since 2020»: at the latest December 2020, at the earliest January 2020.
	const [shortStart, longStart] = periodFromPrecision === 'month' ? [from, from] : [fromYear + 11, fromYear];
	let shortEnd: number;
	let longEnd: number;
	if (periodTo === null) {
		if (!entry.isCurrent) throw new Error(`experience entry ${entry.id} is valid without an end`);
		// The current month is not over: it counts only in the longest reading.
		[shortEnd, longEnd] = [now - 1, now];
	} else {
		if (periodToPrecision === null) throw new Error(`experience entry ${entry.id} has an end without precision`);
		const to = monthIndex(periodTo);
		const toYear = Math.floor(to / 12) * 12;
		// «Until 2022»: at the earliest through January 2022, at the latest through December 2022.
		[shortEnd, longEnd] = periodToPrecision === 'month' ? [to + 1, to + 1] : [toYear + 1, toYear + 12];
	}
	const cap = (value: number) => Math.min(value, now);
	return {
		short: [shortStart, Math.max(shortStart, cap(shortEnd))],
		long: [longStart, Math.max(longStart, cap(longEnd))]
	};
}

function unionLength(intervals: readonly Interval[]): number {
	const sorted = [...intervals].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let total = 0;
	let current: [number, number] | null = null;
	for (const [start, end] of sorted) {
		if (current && start <= current[1]) {
			current[1] = Math.max(current[1], end);
		} else {
			if (current) total += current[1] - current[0];
			current = [start, end];
		}
	}
	if (current) total += current[1] - current[0];
	return total;
}

/** Union of the periods of the given entries; all of them must have a valid period. */
export function experienceMonths(entries: readonly ExperienceInput[], asOf: Date): MonthsRange {
	const all = entries.map((entry) => readings(entry, asOf));
	return {
		min_months: unionLength(all.map((r) => r.short)),
		max_months: unionLength(all.map((r) => r.long))
	};
}

export const hasValidPeriod = (entry: ExperienceInput) => entry.periodStatus === 'valid';

/** Total experience, by role and by applied skill; entries without a valid period are listed as excluded. */
export function summarizeExperience(entries: readonly ExperienceInput[], asOf: Date): ExperienceSummary {
	const counted = entries.filter(hasValidPeriod);
	const byKey = (keysOf: (entry: ExperienceInput) => readonly string[]) => {
		const groups = new Map<string, ExperienceInput[]>();
		for (const entry of counted) {
			for (const key of new Set(keysOf(entry))) groups.set(key, [...(groups.get(key) ?? []), entry]);
		}
		return Object.fromEntries(
			[...groups.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, group]) => [key, experienceMonths(group, asOf)])
		);
	};
	return {
		total: experienceMonths(counted, asOf),
		by_role: byKey((entry) => (entry.roleKey === null ? [] : [entry.roleKey])),
		by_skill: byKey((entry) => entry.appliedSkillKeys),
		counted_entry_ids: counted.map((entry) => entry.id).sort(),
		excluded: entries
			.filter((entry) => !hasValidPeriod(entry))
			.map((entry) => ({
				experience_entry_id: entry.id,
				code: entry.periodStatus === 'missing' ? ('period_missing' as const) : ('period_invalid' as const)
			}))
			.sort((a, b) => (a.experience_entry_id < b.experience_entry_id ? -1 : 1))
	};
}
