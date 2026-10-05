// «Спрос» for the candidate (CONCEPT 4; contracts 5.6): how many needs of companies match the candidate's category, the
// median range and the skills they ask for — an aggregate with the small-count threshold, never a need or a company.
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { needDemand, type CountCell, type MedianRange } from '$lib/server/candidates/need-demand';
import { defineOperation } from '../operation';
import { dateTime, iso } from '../schemas';

const count = z.union([z.object({ value: z.int() }), z.object({ below: z.int().describe('Меньше порога: «< N»') })]);
const range = z
	.object({ needs: z.int(), min: z.int(), max: z.int() })
	.nullable()
	.describe('Медианные границы вилок потребностей, рубли в месяц; `null` — потребностей с вилкой меньше порога');

const cell = (value: CountCell) => ('value' in value ? { value: value.value } : { below: value.below });
const rangeOut = (value: MedianRange | null) => value && { needs: value.needs, min: value.min, max: value.max };

export const getMyNeedDemand = defineOperation({
	id: 'getMyNeedDemand',
	method: 'GET',
	path: '/me/demand',
	tag: 'Кандидат',
	summary: 'Спрос на мою категорию',
	description:
		'Сколько действующих потребностей компаний совпало с действующей категорией кандидата (специализация и грейд ' +
		'в диапазоне потребности), медианная вилка и навыки, которые они требуют, — только агрегатом: меньше порога ' +
		'`catalog_policy` — `{below}`, медиана и навыки — от порога. Без категории — `status: no_category`.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Спрос',
		schema: z.discriminatedUnion('status', [
			z.object({ status: z.literal('no_category') }),
			z.object({
				status: z.literal('available'),
				category: z.object({ specialization: z.enum(SPECIALIZATION_KEYS), grade: z.enum(GRADE_KEYS) }),
				needs: count,
				threshold: z.int(),
				salary: z.object({ gross: range, net: range }),
				skills: z.array(z.object({ skill_key: z.string(), needs: z.int(), share: z.number() })),
				as_of: dateTime
			})
		])
	},
	async handle(ctx) {
		const demand = await needDemand(ctx.services.db, await ctx.subject(), ctx.services.now());
		if (demand.status === 'no_category') return { status: 'no_category' as const };
		return {
			status: 'available' as const,
			category: demand.category,
			needs: cell(demand.needs),
			threshold: demand.threshold,
			salary: { gross: rangeOut(demand.salary.gross), net: rangeOut(demand.salary.net) },
			skills: demand.skills.map((skill) => ({ skill_key: skill.skillKey, needs: skill.needs, share: skill.share })),
			as_of: iso(demand.asOf)
		};
	}
});
