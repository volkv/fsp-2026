// «Спрос» for the candidate (CONCEPT 4; contracts 5.6, block «спрос» of «Категория и грейд»): how many active needs of
// the companies within the candidate's reach match the candidate's category, the median range of those needs and how
// often each skill is required among them — an aggregate only, never a need or a company. A need matches when it names
// the specialization of the category (or names none, and its required skills are confirmed by the blocks of that
// specialization) and its range of grades holds the grade of the category (or names none). Counts below the threshold
// are «< N»; a median and the shares of skills are shown only from the threshold on.
import { and, eq, inArray } from 'drizzle-orm';
import { ADMITTED_COMPANY_STATUSES, can, type AccessSubject } from '$lib/server/access/permissions';
import { CATALOG, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { activeCategories } from '$lib/server/categories/read';
import type { Executor } from '$lib/server/db';
import { companies, hiringNeeds } from '$lib/server/db/schema';
import { demoScope, demoSessionOfUser } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { loadMarketPolicy } from '$lib/server/market/policy';
import { gradesOf, parseNeedForm, type NeedForm } from '$lib/server/needs/form';

export type CountCell = { value: number } | { below: number };

export interface MedianRange {
	/** Needs of this tax base with a range: the median is taken over them. */
	needs: number;
	min: number;
	max: number;
}

export type NeedDemand =
	| { status: 'no_category' }
	| {
			status: 'available';
			category: { specialization: SpecializationKey; grade: GradeKey };
			needs: CountCell;
			threshold: number;
			/** The median lower and upper bound of the ranges, roubles per month; `null` — fewer than the threshold. */
			salary: { gross: MedianRange | null; net: MedianRange | null };
			/** Required skills of the matched needs, the most required first; empty below the threshold. */
			skills: { skillKey: string; needs: number; share: number }[];
			asOf: Date;
	  };

const SKILLS_SHOWN = 10;

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const value =
		sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	// Rounded to a thousand: a median is a market figure, not a value of any one need.
	return Math.round(value / 1000) * 1000;
}

/** Whether the need asks for the category: its specialization (or its skills) and its range of grades. */
export function needMatchesCategory(
	form: NeedForm,
	category: { specialization: SpecializationKey; grade: GradeKey }
): boolean {
	if (form.specialization !== undefined) {
		if (form.specialization !== category.specialization) return false;
	} else {
		const covered = new Set(
			CATALOG.blocks.filter((b) => b.specialization === category.specialization).flatMap((b) => b.skillKeys)
		);
		if (!form.skill_keys.some((key) => covered.has(key))) return false;
	}
	return form.grade === undefined || gradesOf(form.grade).includes(category.grade);
}

export async function needDemand(executor: Executor, subject: AccessSubject, now: Date): Promise<NeedDemand> {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined || !can(subject, 'candidate.self.read', { candidateId }).allowed) {
		throw new ApiError('forbidden');
	}
	// The latest category in force: where the candidate stands now.
	const category = (await activeCategories(executor, [candidateId])).get(candidateId)?.at(-1);
	if (!category) return { status: 'no_category' };
	const session = await demoSessionOfUser(executor, subject.userId);
	const rows = await executor
		.select({ id: hiringNeeds.id, form: hiringNeeds.form })
		.from(hiringNeeds)
		.innerJoin(companies, eq(companies.id, hiringNeeds.companyId))
		.where(
			and(
				eq(hiringNeeds.status, 'active'),
				inArray(companies.status, [...ADMITTED_COMPANY_STATUSES]),
				demoScope({ demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal }, session)
			)
		);
	const pair = { specialization: category.specialization, grade: category.grade };
	const matched = rows.map((row) => parseNeedForm(row.id, row.form)).filter((form) => needMatchesCategory(form, pair));
	const { smallCountThreshold: threshold } = await loadMarketPolicy(executor, now);
	const enough = matched.length >= threshold;
	const rangeOf = (taxBase: 'gross' | 'net'): MedianRange | null => {
		const ranges = matched.flatMap((form) => (form.salary?.tax_base === taxBase ? [form.salary] : []));
		if (ranges.length < threshold) return null;
		return { needs: ranges.length, min: median(ranges.map((r) => r.min)), max: median(ranges.map((r) => r.max)) };
	};
	const counted = new Map<string, number>();
	for (const form of matched) {
		for (const key of new Set(form.skill_keys)) counted.set(key, (counted.get(key) ?? 0) + 1);
	}
	return {
		status: 'available',
		category: pair,
		needs: enough || matched.length === 0 ? { value: matched.length } : { below: threshold },
		threshold,
		salary: { gross: rangeOf('gross'), net: rangeOf('net') },
		skills: enough
			? [...counted.entries()]
					.map(([skillKey, needs]) => ({ skillKey, needs, share: needs / matched.length }))
					.sort((a, b) => b.needs - a.needs || a.skillKey.localeCompare(b.skillKey))
					.slice(0, SKILLS_SHOWN)
			: [],
		asOf: now
	};
}
