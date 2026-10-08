// Words of the specification of the test of a vacancy or a need (docs/domain.md, 13.11) for the employer cabinet.
import type { RequirementCoverage, SpecGap } from '$lib/server/assessments/vacancy-spec';
import { pluralize } from '$lib/components/product/model.js';

/** How the test covers a requirement, in one line. */
export function coverageText(coverage: RequirementCoverage): string {
	switch (coverage.kind) {
		case 'base_stack':
			return `в основе: определяющий блок «${coverage.blockTitle}» — подтверждается тестом категории`;
		case 'base_practice':
			return 'в основе: язык практической задачи — подтверждается, когда кандидат пишет программу на нём';
		case 'vacancy_block':
			return `блок-тест вакансии «${coverage.blockTitle}» — отдельно от решения о грейде`;
		case 'block_on_request':
			return `желательный: блок-тест «${coverage.blockTitle}» можно запросить у кандидата, в набор вакансии не входит`;
		case 'not_at_grade':
			return coverage.itemsInPlan > 0
				? `на этом грейде тестом не подтверждается: блоку «${coverage.blockTitle}» в плане грейда отведено ${coverage.itemsInPlan} ${pluralize(coverage.itemsInPlan, ['задание', 'задания', 'заданий'])}, для отдельного вывода мало`
				: `на этом грейде тестом не проверяется: блока «${coverage.blockTitle}» нет в плане грейда`;
		case 'other_specialization':
			return `в этот тест не входит; навык проверяет блок «${coverage.title}»`;
		case 'not_tested':
			return coverage.reason === 'outside_taxonomy'
				? 'вне справочника навыков — тестом не проверяется'
				: 'тестом платформы не проверяется: ни один блок его не подтверждает';
	}
}

export const GAP_TEXT: Readonly<Record<SpecGap, string>> = {
	no_specialization: 'Роль не проверяется ни одной специализацией теста: основы категории нет.',
	no_grade: 'Грейд вне каталога теста (Intern — Senior) или не указан: основы категории нет.'
};

export const CLOSED_TEXT = {
	disabled: 'специализация выключена в каталоге — тест не проводится',
	not_released: 'банк заданий специализации не выпущен — тест не проводится'
} as const;

/** Seconds as whole minutes, at least one. */
export const minutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));
