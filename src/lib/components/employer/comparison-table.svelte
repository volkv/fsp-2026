<script lang="ts">
	import { TrustChip } from '$lib/components/product/index.js';
	import { labelOf, trustNote, type Labels, type RoleDetails, type TrustDetails } from './model.js';

	/**
	 * Chosen candidates compared by the same requirements of one vacancy (CONCEPT 4), not by a general rating: for each
	 * requirement — fits, by what it is confirmed, unknown or to check at the interview. The role of the vacancy and the
	 * trust in each score head the table: they compare the candidates as a whole.
	 */
	type Requirement =
		{ kind: 'skill'; requirement: 'required' | 'nice'; skillKey: string } | { kind: 'grade' } | { kind: 'salary' };
	type Cell =
		| { kind: 'skill'; status: 'confirmed' | 'derived' | 'claimed' | 'missing' | 'unavailable'; band: string | null }
		| { kind: 'grade' | 'salary'; status: string; value: number | null; detail: string | null };

	interface Component<Details> {
		status: string;
		value: number | null;
		details: Details & { reason?: string };
	}

	interface Comparison {
		requirements: Requirement[];
		candidates: {
			pseudonym: string;
			score: number;
			coverage: number;
			cells: Cell[];
			role: Component<RoleDetails>;
			trust: Component<TrustDetails>;
		}[];
	}

	let { comparison, labels }: { comparison: Comparison; labels: Labels } = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });

	function requirementLabel(requirement: Requirement): string {
		if (requirement.kind === 'grade') return 'Грейд';
		if (requirement.kind === 'salary') return 'Зарплатные ожидания';
		const name = labels.skills[requirement.skillKey] ?? requirement.skillKey;
		return `${name} · ${requirement.requirement === 'required' ? 'обязательный' : 'желательный'}`;
	}

	const GRADE: Record<string, string> = {
		within: 'в диапазоне вакансии',
		below: 'ниже диапазона',
		above: 'выше диапазона',
		category_not_confirmed: 'категория не подтверждена — проверить на собеседовании',
		specialization_other: 'категория другой специализации',
		vacancy_grade_unknown: 'у вакансии не указан'
	};
	const SALARY: Record<string, string> = {
		lower: 'ниже вилки',
		equal: 'совпадает с вилкой',
		overlap: 'пересекается с вилкой',
		higher: 'выше вилки',
		not_comparable: 'несравнимо: другая валюта, период или налоговая база',
		candidate_expectation_missing: 'не указаны — уточнить',
		vacancy_salary_missing: 'у вакансии нет вилки'
	};
	const ROLE_BASIS: Record<string, string> = {
		same_specialization: 'категория специализации вакансии подтверждена тестом',
		category_not_confirmed: 'категория не подтверждена — проверить на собеседовании',
		vacancy_role_unknown: 'у вакансии не указана',
		vacancy_role_without_specialization: 'роль вакансии не относится к специализациям тестов'
	};
	const BAND: Record<string, string> = { weak: 'слабо', moderate: 'средне', strong: 'сильно' };

	type Shown =
		| { kind: 'confirmed'; note: string | null }
		| { kind: 'derived' }
		| { kind: 'claimed' }
		| { kind: 'text'; text: string; muted: boolean };

	/** What one cell says, in words: fits and by what, unknown, or what to check. */
	function shown(cell: Cell | undefined): Shown {
		if (cell === undefined) return { kind: 'text', text: '—', muted: true };
		if (cell.kind === 'skill') {
			switch (cell.status) {
				case 'confirmed':
					return { kind: 'confirmed', note: cell.band === null ? null : labelOf(BAND, cell.band) };
				case 'derived':
					return { kind: 'derived' };
				case 'claimed':
					return { kind: 'claimed' };
				case 'missing':
					return { kind: 'text', text: 'не подтверждён', muted: true };
				case 'unavailable':
					return { kind: 'text', text: 'неизвестно: доказательства профиля не рассчитаны', muted: true };
			}
		}
		const words = cell.kind === 'grade' ? GRADE : SALARY;
		if (cell.detail !== null)
			return { kind: 'text', text: labelOf(words, cell.detail), muted: cell.status !== 'computed' };
		return {
			kind: 'text',
			text: cell.status === 'computed' ? 'учтено' : 'неизвестно',
			muted: cell.status !== 'computed'
		};
	}

	/** The role row: the specializations of the candidate's categories when none is the vacancy's. */
	function roleShown(role: Component<RoleDetails>): Shown {
		if (role.details.basis === 'other_specialization') {
			const own = (role.details.candidate ?? []).map((key) => labelOf(labels.specializations, key)).join(', ');
			return { kind: 'text', text: `категория другой специализации: ${own}`, muted: true };
		}
		const key = role.details.basis ?? role.details.reason;
		return {
			kind: 'text',
			text: key === undefined ? 'неизвестно' : labelOf(ROLE_BASIS, key),
			muted: role.details.basis !== 'same_specialization'
		};
	}

	/** The trust row: how much of the score rests on direct confirmations and on an agreeing grade. */
	function trustShown(trust: Component<TrustDetails>): Shown {
		if (trust.status !== 'computed' || trust.value === null) {
			return { kind: 'text', text: 'недостаточно данных', muted: true };
		}
		const note = trustNote(trust.details, 'company');
		return {
			kind: 'text',
			text: note === undefined ? percent.format(trust.value) : `${percent.format(trust.value)} · ${note}`,
			muted: trust.value === 0
		};
	}

	const rows = $derived([
		{
			label: comparison.candidates[0]?.role.details.vacancy
				? `Роль · ${labelOf(labels.roles, comparison.candidates[0].role.details.vacancy)}`
				: 'Роль',
			cells: comparison.candidates.map((candidate) => ({
				pseudonym: candidate.pseudonym,
				shown: roleShown(candidate.role)
			}))
		},
		{
			label: 'Доверие к оценке',
			cells: comparison.candidates.map((candidate) => ({
				pseudonym: candidate.pseudonym,
				shown: trustShown(candidate.trust)
			}))
		},
		...comparison.requirements.map((requirement, index) => ({
			label: requirementLabel(requirement),
			cells: comparison.candidates.map((candidate) => ({
				pseudonym: candidate.pseudonym,
				shown: shown(candidate.cells[index])
			}))
		}))
	]);
</script>

<div class="overflow-x-auto rounded-xl border" data-testid="comparison">
	<table class="w-full min-w-xl border-collapse text-sm">
		<caption class="sr-only">Сравнение кандидатов по требованиям вакансии</caption>
		<thead>
			<tr class="border-b bg-muted/40">
				<th scope="col" class="px-3 py-2 text-left font-medium">Требование</th>
				{#each comparison.candidates as candidate (candidate.pseudonym)}
					<th scope="col" class="px-3 py-2 text-left font-medium">
						{candidate.pseudonym}
						<span class="block text-xs font-normal text-muted-foreground">
							{percent.format(candidate.score)} · покрытие {percent.format(candidate.coverage)}
						</span>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row, index (index)}
				<tr class="border-b last:border-b-0">
					<th scope="row" class="px-3 py-2 text-left font-normal">{row.label}</th>
					{#each row.cells as cell (cell.pseudonym)}
						<td class="px-3 py-2 align-top">
							{#if cell.shown.kind === 'confirmed'}
								<span class="font-medium text-success">подтверждено</span>
								{#if cell.shown.note}<span class="ml-1 text-xs text-muted-foreground">{cell.shown.note}</span>{/if}
							{:else if cell.shown.kind === 'derived'}
								<TrustChip level="derived" />
							{:else if cell.shown.kind === 'claimed'}
								<TrustChip level="claimed" />
								<span class="block text-xs text-muted-foreground">проверить на собеседовании</span>
							{:else}
								<span class={cell.shown.muted ? 'text-muted-foreground' : ''}>{cell.shown.text}</span>
							{/if}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>
