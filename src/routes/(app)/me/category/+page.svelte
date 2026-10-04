<script lang="ts">
	import FlagIcon from '@lucide/svelte/icons/flag';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		disciplineShort,
		DISPUTE_STATUSES,
		FSP_LEVELS,
		GRADE_SIGNALS,
		IGNORED_EVIDENCE,
		missingText,
		requirementText,
		roleName,
		skillGroup,
		skillName,
		gradeName,
		type MissingItem
	} from '$lib/components/candidate/model.js';
	import DemandBlock from '$lib/components/candidate/demand-block.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import {
		CategoryAxes,
		InsufficientData,
		RecommendationNotice,
		ResponseDeadline
	} from '$lib/components/product/index.js';
	import { DISCIPLINES, formatDate, type CategoryView, type DisciplineCode } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const category = $derived(data.category);
	const labels = $derived(category.labels);
	const primary = $derived(category.assignments.find((a) => a.rank === 'primary') ?? null);
	const secondary = $derived(category.assignments.filter((a) => a.rank === 'secondary'));
	const explanation = $derived(primary && !('origin' in primary.explanation) ? primary.explanation : null);
	const override = $derived(primary && 'origin' in primary.explanation ? primary.explanation : null);
	const missing = $derived(category.missing ?? { role: [], grade: [], stack: [] });
	const scale = $derived(category.gradeScale.map((grade) => grade.name));
	const indexOf = (key: string) => category.gradeScale.findIndex((grade) => grade.key === key);
	const firstHint = (items: readonly MissingItem[]) => (items[0] ? missingText(items[0], labels) : undefined);
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });

	const isDiscipline = (code: string): code is DisciplineCode => code in DISCIPLINES && code !== 'unknown';
	const fspLevels = $derived(
		category.fspLevels.flatMap((item) =>
			isDiscipline(item.discipline) ? [{ discipline: item.discipline, level: item.level }] : []
		)
	);

	const view = $derived.by((): CategoryView => {
		const desired = category.desiredRoleKeys[0];
		const inferredRole = primary?.role.status === 'established' ? primary.role.key : null;
		return {
			role:
				primary?.role.status === 'established'
					? { status: 'established', label: roleName(labels, primary.role.key) }
					: { status: 'insufficient_data', ...optionalHint(firstHint(missing.role)) },
			grade:
				primary?.grade.status === 'established' && indexOf(primary.grade.min) >= 0 && indexOf(primary.grade.max) >= 0
					? {
							status: 'established',
							scale,
							min: indexOf(primary.grade.min),
							max: indexOf(primary.grade.max),
							confidence: primary.grade.confidence
						}
					: { status: 'insufficient_data', ...optionalHint(firstHint(missing.grade)) },
			stack:
				primary?.stack.status === 'established'
					? { status: 'established', skills: primary.stack.skillKeys.map((key) => skillName(labels, key)) }
					: { status: 'insufficient_data', ...optionalHint(firstHint(missing.stack)) },
			...(desired !== undefined && desired !== inferredRole ? { desiredRole: roleName(labels, desired) } : {}),
			fspLevels
		};
	});

	function optionalHint(hint: string | undefined): { hint?: string } {
		return hint === undefined ? {} : { hint };
	}

	const activeDispute = $derived(
		category.disputes.find(
			(dispute) => dispute.runId === category.run?.id && (dispute.status === 'open' || dispute.status === 'in_review')
		) ?? null
	);
	const problem = $derived(form && 'problem' in form ? form.problem : null);

	const missingGroups = $derived([
		{ axis: 'role', title: 'Роль', items: missing.role },
		{ axis: 'grade', title: 'Грейд', items: missing.grade },
		{ axis: 'stack', title: 'Ядро стека', items: missing.stack }
	]);
</script>

<PageHeader
	title="Твоя категория"
	description="Роль × грейд × ядро стека — по независимым осям: известное сохраняется, даже когда другая ось не установлена. Грейд — диапазон с уверенностью, уровень ФСП — отдельно от грейда."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

<RecommendationNotice />

{#if category.state === 'none'}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><GaugeIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Категория ещё не рассчитана</Empty.Title>
			<Empty.Description>
				Расчёт запускается после импорта достижений, разбора резюме или теста. Без категории ты всё равно находим по
				навыкам и уровню ФСП.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if category.state === 'recalculating'}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><GaugeIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Категория пересчитывается</Empty.Title>
			<Empty.Description>
				Одно из оснований изъято или изменилось — прежняя категория снята с карточки до нового расчёта.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<SectionCard
		title="Категория по осям"
		description={category.run
			? `Рассчитано ${formatDate(category.run.computedAt)} · правила v${category.run.rulesetVersion}${category.taxonomyLabel ? ` · таксономия ${category.taxonomyLabel}` : ''}`
			: undefined}
		testId="category-axes"
	>
		<CategoryAxes category={view} />
		{#if override}
			<p class="rounded-lg bg-info-subtle p-3 text-sm text-info">
				Категорию установил оператор ФСП по твоему возражению{category.run?.overrideReason
					? `: «${category.run.overrideReason}»`
					: ''}. Решение действует, пока профиль не изменится.
			</p>
		{/if}
	</SectionCard>

	<SectionCard
		title="Чего не хватает"
		description="Конкретные основания, которых нет у каждой оси. «Не подтверждено» — это не «отсутствует»: навык мог просто не попасть в проверяемые факты."
		testId="missing-grounds"
	>
		{#if missingGroups.every((group) => group.items.length === 0)}
			<p class="text-sm">Все три оси установлены.</p>
		{:else}
			<div class="grid gap-4 md:grid-cols-3">
				{#each missingGroups as group (group.axis)}
					<div class="grid content-start gap-2" data-axis={group.axis}>
						<h3 class="text-sm font-semibold">{group.title}</h3>
						{#if group.items.length === 0}
							<p class="text-sm text-muted-foreground">Установлена.</p>
						{:else}
							<ul class="grid gap-1.5 text-sm">
								{#each group.items as item, index (index)}
									<li class="rounded-md border border-dashed p-2">{missingText(item, labels)}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</SectionCard>

	{#if explanation?.grade.next_grade}
		{@const next = explanation.grade.next_grade}
		<SectionCard
			title="Апсолв до следующего грейда: {gradeName(labels, next.target)}"
			description="Требования правил категоризации к следующему грейду. Это не обещание повышения: грейд ставят по подтверждённым основаниям."
			testId="next-grade"
		>
			<ul class="grid gap-2 text-sm">
				{#each next.requirements as requirement, index (index)}
					<li class="flex gap-2">
						<FlagIcon class="mt-0.5 size-4 shrink-0 text-link" aria-hidden="true" />
						{requirementText(requirement, labels)}
					</li>
				{/each}
			</ul>
		</SectionCard>
	{/if}

	<DemandBlock demand={data.demand} {labels} />

	{#if explanation}
		<SectionCard title="Почему такая категория" description="Правила и основания, по которым установлена каждая ось.">
			<div class="grid gap-5 md:grid-cols-3">
				<div class="grid content-start gap-2 text-sm">
					<h3 class="font-semibold">Роль</h3>
					{#if 'role_key' in explanation.role}
						<p>
							{roleName(labels, explanation.role.role_key)}: оснований {percent.format(explanation.role.score)}.
						</p>
						<ul class="grid gap-1">
							{#each explanation.role.core_groups as group, index (index)}
								<li>
									{skillGroup(labels, group.skills)}:
									{#if group.satisfied_by}
										подтверждено навыком «{skillName(labels, group.satisfied_by)}»
									{:else}
										<span class="text-muted-foreground">не подтверждено</span>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<InsufficientData />
					{/if}
				</div>
				<div class="grid content-start gap-2 text-sm">
					<h3 class="font-semibold">Грейд</h3>
					{#if explanation.grade.signals.length > 0}
						<p>
							Сигналы: {explanation.grade.signals
								.map((signal) => GRADE_SIGNALS[signal.signal] ?? signal.signal)
								.join(', ')}.
						</p>
					{:else}
						<p class="text-muted-foreground">Производственных сигналов нет.</p>
					{/if}
					{#each explanation.grade.ignored as item (item.code)}
						<p class="text-muted-foreground">{IGNORED_EVIDENCE[item.code] ?? item.code}</p>
					{/each}
				</div>
				<div class="grid content-start gap-2 text-sm">
					<h3 class="font-semibold">Ядро стека</h3>
					{#if explanation.stack.skills.length > 0}
						<ul class="grid gap-1">
							{#each explanation.stack.skills as skill (skill.skill_key)}
								<li>
									{skillName(labels, skill.skill_key)} — оснований {percent.format(skill.strength)}
								</li>
							{/each}
						</ul>
					{:else}
						<InsufficientData />
					{/if}
				</div>
			</div>
			{#if explanation.desired_roles.length > 0}
				<div class="grid gap-1 text-sm">
					<h3 class="font-semibold">Желаемые роли</h3>
					<ul class="grid gap-1">
						{#each explanation.desired_roles as desired (desired.role_key)}
							<li>
								{roleName(labels, desired.role_key)} —
								{desired.status === 'primary'
									? 'совпадает с выведенной'
									: desired.status === 'secondary'
										? 'выведена как дополнительная'
										: desired.status === 'unknown_role'
											? 'нет в справочнике этой версии'
											: 'пока не выведена'}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</SectionCard>
	{/if}

	{#if secondary.length > 0}
		<SectionCard title="Дополнительные роли" description="Роли, по которым оснований тоже достаточно.">
			<ul class="grid gap-1 text-sm">
				{#each secondary as item, index (index)}
					<li>{item.role.status === 'established' ? roleName(labels, item.role.key) : 'Роль не установлена'}</li>
				{/each}
			</ul>
		</SectionCard>
	{/if}
{/if}

<SectionCard
	title="Уровень ФСП"
	description="Отдельный фасет, а не грейд: олимпиадника без коммерческого опыта находят по уровню ФСП, а не по выдуманному грейду."
	testId="fsp-levels"
>
	{#if category.fspLevels.length === 0}
		<InsufficientData hint="Нет официальных результатов ФСП в профиле." />
	{:else}
		<ul class="grid gap-2 sm:grid-cols-2">
			{#each category.fspLevels as item (item.discipline)}
				<li class="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
					<span>
						<span class="font-medium">{disciplineShort(item.discipline)}</span>
						<span class="block text-xs text-muted-foreground">{FSP_LEVELS[item.level]}</span>
					</span>
					<span class="font-mono text-lg text-link">{item.level}</span>
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>

<SectionCard
	title="Возражение"
	description="Не согласен с категорией — напиши, что не так. Оператор ФСП отвечает в течение 30 дней; категория — подсказка, решение о приглашении всё равно принимает человек."
	testId="dispute"
>
	{#if problem}
		<FormMessage text={problem.message} />
	{:else if form && 'disputeOpened' in form}
		<FormMessage tone="success" text="Возражение подано. Ответ придёт уведомлением." />
	{:else if form && 'disputeWithdrawn' in form}
		<FormMessage tone="success" text="Возражение отозвано." />
	{/if}

	{#if activeDispute}
		<div class="grid gap-3 rounded-lg border p-4" data-testid="active-dispute">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<StatusPill
					label={DISPUTE_STATUSES[activeDispute.status].label}
					tone={DISPUTE_STATUSES[activeDispute.status].tone}
				/>
				<ResponseDeadline dueAt={activeDispute.dueAt} label="Ответ оператора до" />
			</div>
			<p class="text-sm whitespace-pre-line">{activeDispute.reason}</p>
			<form method="POST" action="?/withdraw" use:enhance>
				<CsrfInput />
				<input type="hidden" name="disputeId" value={activeDispute.id} />
				<Button type="submit" variant="outline" size="sm">Отозвать возражение</Button>
			</form>
		</div>
	{:else if category.run}
		<form method="POST" action="?/dispute" use:enhance class="grid gap-3">
			<CsrfInput />
			<input type="hidden" name="runId" value={category.run.id} />
			<label class="grid gap-1.5 text-sm">
				<span>Что не так с категорией</span>
				<Textarea name="reason" required maxlength={4000} rows={4} />
			</label>
			<Button type="submit" class="justify-self-start">Подать возражение</Button>
		</form>
	{:else}
		<p class="text-sm text-muted-foreground">Возразить можно, когда категория рассчитана.</p>
	{/if}

	{#if category.disputes.some((dispute) => dispute.id !== activeDispute?.id)}
		<details class="text-sm">
			<summary class="cursor-pointer text-muted-foreground">История возражений</summary>
			<ul class="mt-2 grid gap-2">
				{#each category.disputes.filter((dispute) => dispute.id !== activeDispute?.id) as dispute (dispute.id)}
					<li class="grid gap-1 rounded-md border p-3">
						<span class="flex flex-wrap items-center gap-2">
							<StatusPill label={DISPUTE_STATUSES[dispute.status].label} tone={DISPUTE_STATUSES[dispute.status].tone} />
							<span class="text-xs text-muted-foreground">подано {formatDate(dispute.openedAt)}</span>
						</span>
						{#if dispute.resolution}<span>Ответ оператора: {dispute.resolution}</span>{/if}
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</SectionCard>
