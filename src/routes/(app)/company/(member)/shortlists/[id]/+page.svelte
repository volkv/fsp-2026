<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ShortlistRow from '$lib/components/employer/shortlist-row.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import {
		categoryName,
		CHANGE_NAMES,
		cohortCount,
		intervalText,
		WHAT_IF_REASONS
	} from '$lib/components/employer/shortlist.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { RecommendationNotice } from '$lib/components/product/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const shortlist = $derived(data.shortlist);
	const names = $derived(data.names);
	const query = $derived(shortlist.revision.query);
	const latest = $derived(shortlist.revision.seq === shortlist.latestSeq);
	const editable = $derived(latest && shortlist.status === 'open');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const skillNames = (keys: readonly string[]) => keys.map((key) => names.skills[key] ?? key).join(', ');
	const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
	const shareText = (part: { withoutFsp: number; of: number }) =>
		part.of === 0 ? '—' : `${part.withoutFsp} из ${part.of}`;
	const changeText = (change: Record<string, { from: unknown; to: unknown }>) =>
		Object.keys(change)
			.map((key) => CHANGE_NAMES[key] ?? key)
			.join(', ');
	const MARK_STATES = {
		in_results: 'в выдаче',
		not_matching: 'не проходит новое условие',
		unavailable: 'кандидат больше недоступен'
	} as const;
</script>

<PageHeader
	title="Подборка"
	description="Кандидаты подтверждённых категорий по соответствию потребности и силе подтверждённого профиля. Карточки показываются заново при каждом открытии — только те, кого ваша компания видит сейчас."
>
	{#snippet eyebrow()}
		<a
			class="text-link underline-offset-4 hover:underline"
			href={resolve('/(app)/company/(member)/needs/[id]', { id: shortlist.needId })}>Потребность</a
		>
	{/snippet}
	{#snippet actions()}
		<a
			class={buttonVariants({ variant: 'outline' })}
			href={resolve('/(app)/company/(member)/shortlists/[id]/evaluate', { id: shortlist.id })}
			data-testid="shortlist-evaluate">Оцените подбор</a
		>
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'revised' in form}
	<FormMessage tone="success" text={`Подборка уточнена: шаг ${form.revised}. Отмеченные сохранены.`} />
{/if}

<RecommendationNotice compact />

<div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="grid content-start gap-4">
		<Card.Root>
			<Card.Content class="grid gap-2 pt-6 text-sm">
				<p>
					<span class="font-medium">Шаг {shortlist.revision.seq} из {shortlist.latestSeq}</span>
					· категории: {query.categories.map((c) => categoryName(c, names)).join('; ')}
				</p>
				<p class="text-muted-foreground">
					Обязательные: {skillNames(query.form.skill_keys) || 'не указаны'}
					{#if query.form.nice_skill_keys.length > 0}· желательные: {skillNames(query.form.nice_skill_keys)}{/if}
					{#if query.form.work_format}· формат: {names.workFormats[query.form.work_format] ??
							query.form.work_format}{/if}
					{#if query.filters.fsp_only}· только с подтверждённым ФСП{/if}
					{#if query.filters.confirmed_skill_keys.length > 0}
						· подтверждено тестом: {skillNames(query.filters.confirmed_skill_keys)}
					{/if}
				</p>
				<p data-testid="shortlist-exposure">
					Найдено: <span class="font-medium">{shortlist.total}</span> · без результатов ФСП в первой десятке —
					{shareText(shortlist.exposure.top)}, во всей выдаче — {shareText(shortlist.exposure.pool)}
				</p>
				{#if shortlist.mode.searchMode === 'fts_only' && shortlist.mode.semanticReason !== 'no_query'}
					<p class="text-xs text-muted-foreground">
						Смысловая близость недоступна: почти равные кандидаты упорядочены по силе подтверждённого профиля.
					</p>
				{/if}
				{#if !latest}
					<p class="text-sm">
						Вы смотрите прошлый шаг.
						<a
							class="text-link underline"
							href={resolve('/(app)/company/(member)/shortlists/[id]', { id: shortlist.id })}>К текущему шагу</a
						>
					</p>
				{/if}
			</Card.Content>
		</Card.Root>

		{#each shortlist.items as item (item.pseudonym)}
			<ShortlistRow
				pseudonym={item.pseudonym}
				match={item.match}
				offerFit={item.offerFit}
				mark={item.mark}
				hasFsp={item.hasFsp}
				{names}
				cardHref={resolve('/(app)/company/(member)/candidates/[pseudonym]', { pseudonym: item.pseudonym })}
				offerQuery={`?shortlist=${shortlist.id}`}
				{editable}
			/>
		{:else}
			<Empty.Root class="border">
				<Empty.Header>
					<Empty.Title>В категориях подборки сейчас никого</Empty.Title>
					<Empty.Description>Добавьте соседнюю категорию или ослабьте фильтры уточнением.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/each}
		{#if shortlist.nextCursor}
			<form method="GET" class="justify-self-center">
				<input type="hidden" name="revision" value={shortlist.revision.seq} />
				<input type="hidden" name="cursor" value={shortlist.nextCursor} />
				<Button type="submit" variant="outline">Следующие кандидаты</Button>
			</form>
		{/if}
	</div>

	<aside class="grid content-start gap-4">
		{#if shortlist.salary}
			<Card.Root data-testid="shortlist-salary">
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Подходит ли вилка</h2></Card.Title>
					<Card.Description>
						Ожидания кандидатов скрыты: ответ — по всей категории, которую видит компания, по интервалам и снимку раз в
						сутки, числа округлены вниз до пяти.
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-2 text-sm">
					{#each shortlist.salary as answer (`${answer.specialization}:${answer.grade}`)}
						<p>
							<span class="font-medium">{categoryName(answer, names)}</span>: ваша вилка до
							{intervalText(answer.interval)} не ниже ожиданий у {cohortCount(answer.not_below)} из {cohortCount(
								answer.of
							)}
						</p>
					{/each}
				</Card.Content>
			</Card.Root>
		{/if}

		<Card.Root data-testid="shortlist-marked">
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Отмеченные</h2></Card.Title>
			</Card.Header>
			<Card.Content class="grid gap-2 text-sm">
				{#each shortlist.marked as mark, index (mark.pseudonym ?? `gone-${index}`)}
					<p data-mark-state={mark.state}>
						{#if mark.pseudonym}
							<a
								class="text-link underline-offset-4 hover:underline"
								href={resolve('/(app)/company/(member)/candidates/[pseudonym]', { pseudonym: mark.pseudonym })}
								>Кандидат {mark.pseudonym}</a
							>
						{:else}
							Кандидат
						{/if}
						— {MARK_STATES[mark.state]}{mark.position ? `, позиция ${mark.position}` : ''}
						{#if mark.note}<span class="block text-xs text-muted-foreground">{mark.note}</span>{/if}
					</p>
				{:else}
					<p class="text-muted-foreground">Отметьте кандидатов — уточнения их не выбросят.</p>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">История уточнений</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				<ol class="grid gap-1 text-sm">
					{#each shortlist.history as step (step.seq)}
						<li>
							<a
								class="text-link underline-offset-4 hover:underline"
								href="{resolve('/(app)/company/(member)/shortlists/[id]', { id: shortlist.id })}?revision={step.seq}"
								aria-current={step.seq === shortlist.revision.seq ? 'step' : undefined}>Шаг {step.seq}</a
							>
							<span class="text-muted-foreground">
								· {step.seq === 1 ? 'начало' : changeText(step.change)} · {date.format(step.createdAt)}
							</span>
						</li>
					{/each}
				</ol>
			</Card.Content>
		</Card.Root>

		{#if editable}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Уточнить</h2></Card.Title>
					<Card.Description>Новый шаг; подборка и отметки сохраняются.</Card.Description>
				</Card.Header>
				<Card.Content>
					<form method="POST" action="?/revise" use:enhance class="grid gap-3 text-sm" data-testid="shortlist-revise">
						<CsrfInput />
						<fieldset class="grid gap-1">
							<legend class="mb-1 font-medium">Категории</legend>
							{#each data.categories as category (`${category.specialization}:${category.grade}`)}
								<label class="flex items-center gap-2">
									<input
										type="checkbox"
										class="size-4"
										name="category"
										value={`${category.specialization}:${category.grade}`}
										checked={query.categories.some(
											(c) => c.specialization === category.specialization && c.grade === category.grade
										)}
									/>
									{categoryName(category, names)}
								</label>
							{/each}
						</fieldset>
						<label class="grid gap-1">
							Обязательные навыки
							<Input name="skill_keys" value={skillNames(query.form.skill_keys)} />
						</label>
						<label class="grid gap-1">
							Желательные навыки
							<Input name="nice_skill_keys" value={skillNames(query.form.nice_skill_keys)} />
						</label>
						<label class="grid gap-1">
							Подтверждено тестом (фильтр)
							<Input name="confirmed_skill_keys" value={skillNames(query.filters.confirmed_skill_keys)} />
						</label>
						<label class="grid gap-1">
							Формат работы
							<NativeSelect name="work_format" value={query.form.work_format ?? ''}>
								<option value="">не важен</option>
								{#each Object.entries(names.workFormats) as [key, name] (key)}
									{#if ['office', 'hybrid', 'remote'].includes(key)}<option value={key}>{name}</option>{/if}
								{/each}
							</NativeSelect>
						</label>
						<label class="flex items-center gap-2">
							<input type="checkbox" class="size-4" name="fsp_only" checked={query.filters.fsp_only} />
							Только с подтверждёнными результатами ФСП
						</label>
						<label class="flex items-center gap-2">
							<input type="checkbox" class="size-4" name="fsp_relevant" checked={query.form.fsp_relevant !== false} />
							Результаты ФСП важны для потребности
						</label>
						<Button type="submit" class="justify-self-start">Уточнить</Button>
					</form>
				</Card.Content>
			</Card.Root>
		{/if}

		<Card.Root data-testid="shortlist-what-if">
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Что если</h2></Card.Title>
				<Card.Description>Одно условие — кто станет доступен и кто выпадет, и почему.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				<form method="GET" class="grid gap-2">
					<NativeSelect name="whatIf" value="work_format">
						<option value="work_format">Формат работы</option>
						<option value="grade">Грейд</option>
						<option value="confirmed_skill">Навык, подтверждённый тестом</option>
						<option value="fsp_only">Только с ФСП (on / off)</option>
					</NativeSelect>
					<Input name="value" placeholder="remote · senior · Kafka · on" />
					<Button type="submit" variant="outline" class="justify-self-start">Посмотреть</Button>
				</form>
				{#if query.form.salary}
					<form method="GET" class="grid gap-2">
						<input type="hidden" name="whatIf" value="salary" />
						<div class="grid grid-cols-2 gap-2">
							<Input name="min" inputmode="numeric" placeholder="от, ₽" value={String(query.form.salary.min)} />
							<Input name="max" inputmode="numeric" placeholder="до, ₽" value={String(query.form.salary.max)} />
						</div>
						<input type="hidden" name="tax_base" value={query.form.salary.tax_base} />
						<Button type="submit" variant="outline" class="justify-self-start">Если изменить вилку</Button>
					</form>
				{/if}
				{#if data.whatIf}
					<div class="grid gap-2 rounded-lg border p-3" data-testid="what-if-answer">
						{#if data.whatIf.salary}
							{#each data.whatIf.salary.after as answer (`${answer.specialization}:${answer.grade}`)}
								<p>
									{categoryName(answer, names)}: до {intervalText(answer.interval)} — не ниже ожиданий у
									{cohortCount(answer.not_below)} из {cohortCount(answer.of)}
								</p>
							{/each}
						{:else}
							<p>Было {data.whatIf.before}, станет {data.whatIf.after}.</p>
							{#if data.whatIf.entered.length > 0}
								<p class="font-medium">Станут доступны</p>
								<ul class="grid gap-1">
									{#each data.whatIf.entered as entry (entry.pseudonym)}
										<li>
											Кандидат {entry.pseudonym} — {WHAT_IF_REASONS[entry.reason.code] ?? entry.reason.code}
											{entry.reason.code === 'category'
												? categoryName(
														{ specialization: entry.reason.specialization, grade: entry.reason.grade },
														names
													)
												: ''}
										</li>
									{/each}
								</ul>
							{/if}
							{#if data.whatIf.left.length > 0}
								<p class="font-medium">Выпадут</p>
								<ul class="grid gap-1">
									{#each data.whatIf.left as entry (entry.pseudonym)}
										<li>Кандидат {entry.pseudonym} — {WHAT_IF_REASONS[entry.reason.code] ?? entry.reason.code}</li>
									{/each}
								</ul>
							{/if}
						{/if}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if data.evaluations.mean}
			<Card.Root data-testid="shortlist-evaluations">
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Оценки подбора</h2></Card.Title>
				</Card.Header>
				<Card.Content class="text-sm">
					<p>
						Оценок: {data.evaluations.judged.length} · Precision@10: подборка {data.evaluations.mean.precision_at_10
							.product}, поиск по словам {data.evaluations.mean.precision_at_10.keywords}
					</p>
					<p class="text-muted-foreground">
						Предпочтение: подборка {data.evaluations.mean.product_wins}, поиск по словам {data.evaluations.mean
							.keyword_wins}
					</p>
				</Card.Content>
			</Card.Root>
		{/if}
	</aside>
</div>
