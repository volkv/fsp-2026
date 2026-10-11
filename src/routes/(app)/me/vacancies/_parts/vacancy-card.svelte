<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import MailIcon from '@lucide/svelte/icons/mail';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import XIcon from '@lucide/svelte/icons/x';
	import { InvitationStatus, MatchBreakdown } from '$lib/components/product/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import { clamp01, componentShort, pathOf, plural, toneOf } from './score.js';
	import Radar from './match-radar.svelte';
	import Ring from './score-ring.svelte';
	import type { SkillView, VacancyCard } from './view.js';

	let { item, featured = false }: { item: VacancyCard; featured?: boolean } = $props();

	const tone = $derived(toneOf(item.score));
	const limit = $derived(featured ? 12 : 6);
	const heaviest = $derived([...item.components].sort((a, b) => b.weight - a.weight).slice(0, featured ? 4 : 3));

	function haveText(skill: SkillView): string {
		return skill.have === true ? 'подтверждён' : skill.have === false ? 'нет в профиле' : 'не известно';
	}
</script>

<article
	class={cn(
		'group/card relative isolate flex h-full flex-col gap-4 overflow-hidden rounded-2xl border bg-card p-4 shadow-xs transition duration-300 ease-standard hover:-translate-y-0.5 hover:border-ring/40 hover:shadow-xl hover:shadow-brand-500/10 sm:p-5 dark:hover:shadow-brand-300/10',
		featured && 'border-primary/30 sm:p-6'
	)}
>
	<div
		aria-hidden="true"
		class={cn(
			'glow pointer-events-none absolute inset-0 -z-10 transition-opacity duration-500',
			featured ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'
		)}
	></div>

	{#if featured || item.invitation}
		<div class="flex flex-wrap items-center gap-2">
			{#if featured}
				<span
					class="inline-flex h-6 items-center gap-1 rounded-full bg-primary px-2.5 text-xs font-medium text-primary-foreground"
				>
					<SparklesIcon class="size-3.5" aria-hidden="true" />
					Лучшее совпадение
				</span>
			{/if}
			{#if item.invitation}
				<span
					class="inline-flex h-6 items-center gap-1 rounded-full border border-primary/30 bg-accent px-2.5 text-xs font-medium text-accent-foreground"
				>
					<MailIcon class="size-3.5" aria-hidden="true" />
					Вас пригласили
				</span>
			{/if}
		</div>
	{/if}

	<div class={cn('grid content-start gap-4', featured && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)] lg:gap-x-8')}>
		<header class={cn('flex items-center gap-4', featured && 'lg:col-span-2')}>
			<Ring score={item.score} size={featured ? 132 : 72} stroke={featured ? 11 : 7} />
			<div class="grid min-w-0 gap-1">
				<h2 class={cn('font-heading leading-tight text-balance', featured ? 'text-h2' : 'text-lg')}>
					<a
						href={pathOf(item.href)}
						class="decoration-primary/40 underline-offset-4 outline-none hover:underline focus-visible:underline"
						>{item.title}</a
					>
				</h2>
				<p class="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
					<span class="truncate">{item.company}</span>
					{#if item.verified}
						<BadgeCheckIcon class="size-4 shrink-0 text-link" aria-hidden="true" />
						<span class="sr-only">— компания проверена</span>
					{/if}
				</p>
				<p class={cn('text-xs font-medium', tone.text)}>{tone.label}</p>
			</div>
		</header>

		<dl class="flex flex-wrap items-center gap-2 text-sm">
			<div class="inline-flex items-baseline gap-1.5 rounded-lg bg-muted px-2.5 py-1">
				<dt class="sr-only">Зарплата</dt>
				<dd class={cn('font-medium numeric', item.salaryText === null && 'font-normal text-muted-foreground')}>
					{item.salaryText ?? 'зарплата не указана'}
				</dd>
				{#if item.salaryText !== null && item.salaryPeriod !== null}
					<dd class="text-xs text-muted-foreground">{item.salaryPeriod}</dd>
				{/if}
			</div>
			<div class="inline-flex items-center rounded-lg border px-2.5 py-1">
				<dt class="sr-only">Грейд</dt>
				<dd>{item.grade}</dd>
			</div>
			<div class="inline-flex items-center rounded-lg border px-2.5 py-1">
				<dt class="sr-only">Формат</dt>
				<dd>{item.format}</dd>
			</div>
		</dl>

		{#if heaviest.length > 0}
			<ul class="grid gap-1.5" aria-label="Главные компоненты соответствия">
				{#each heaviest as component (component.key)}
					<li class="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
						<span class="truncate text-muted-foreground">{componentShort[component.key]}</span>
						<span class="h-1.5 overflow-hidden rounded-full bg-muted">
							{#if component.value !== null}
								<span
									class={cn('rise block h-full rounded-full', toneOf(component.value).bar)}
									style:width="{clamp01(component.value) * 100}%"
								></span>
							{/if}
						</span>
						<span class="text-right font-mono numeric">
							{component.value === null ? '—' : Math.round(clamp01(component.value) * 100)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if item.skills.length > 0}
			<div class="grid gap-2">
				<p class="text-xs text-muted-foreground">
					Навыки ·
					{#if item.missing.length === 0}
						<span class="text-success">все обязательные есть</span>
					{:else}
						<span class="text-destructive">
							не хватает {item.missing.length}
							{plural(item.missing.length, ['обязательного', 'обязательных', 'обязательных'])}
						</span>
					{/if}
				</p>
				<ul class="flex flex-wrap gap-1.5" aria-label="Навыки вакансии">
					{#each item.skills.slice(0, limit) as skill (skill.key)}
						<li
							class={cn(
								'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs whitespace-nowrap',
								skill.have === true && 'border-success/30 bg-success-subtle text-success',
								skill.have === false && 'border-destructive/30 bg-danger-subtle text-destructive',
								skill.have === null && 'border-dashed text-muted-foreground',
								!skill.required && 'opacity-75'
							)}
							title="{skill.required ? 'Обязательный' : 'Желательный'} · {haveText(skill)}"
						>
							{#if skill.have === true}
								<CheckIcon class="size-3.5" aria-hidden="true" />
							{:else if skill.have === false}
								<XIcon class="size-3.5" aria-hidden="true" />
							{:else}
								<CircleDashedIcon class="size-3.5" aria-hidden="true" />
							{/if}
							<span class={skill.required ? 'font-medium' : ''}>{skill.name}</span>
							<span class="sr-only">— {skill.required ? 'обязательный' : 'желательный'}, {haveText(skill)}</span>
						</li>
					{/each}
					{#if item.skills.length > limit}
						<li class="inline-flex h-7 items-center px-1 text-xs text-muted-foreground">
							+{item.skills.length - limit}
						</li>
					{/if}
				</ul>
			</div>
		{/if}

		{#if featured && item.components.length >= 3}
			<div class="grid content-center justify-items-center gap-1 lg:col-start-2 lg:row-span-4 lg:row-start-2">
				<Radar components={item.components} />
				<p class="text-xs text-muted-foreground">Профиль совпадения по компонентам</p>
			</div>
		{/if}
	</div>

	<div class="mt-auto grid gap-3">
		{#if item.invitation}
			<p class="flex flex-wrap items-center gap-2 text-sm">
				<InvitationStatus status={item.invitation.status} />
				<a class="text-link underline underline-offset-4" href={pathOf(item.invitation.href)}>Открыть приглашение</a>
			</p>
		{/if}

		<div class="flex flex-wrap items-center justify-between gap-2">
			<span class="text-xs text-muted-foreground">
				{#if item.toVerify > 0}
					{item.toVerify}
					{plural(item.toVerify, ['пункт уточнят', 'пункта уточнят', 'пунктов уточнят'])} на собеседовании
				{/if}
			</span>
			<a
				href={pathOf(item.href)}
				class={cn(buttonVariants({ variant: featured ? 'default' : 'outline', size: 'sm' }), 'group/go')}
				data-testid="vacancy-apply"
			>
				Вакансия и отклик
				<ArrowRightIcon class="transition-transform group-hover/go:translate-x-0.5" aria-hidden="true" />
			</a>
		</div>

		<details class="group/why rounded-xl border bg-background/60">
			<summary
				class="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden"
			>
				Почему подходит
				<ChevronDownIcon
					class="size-4 text-muted-foreground transition-transform group-open/why:rotate-180"
					aria-hidden="true"
				/>
			</summary>
			<div class="border-t p-3">
				<MatchBreakdown match={item.match} />
			</div>
		</details>
	</div>
</article>

<style>
	.glow {
		background: radial-gradient(
			28rem circle at 100% 0%,
			color-mix(in oklab, var(--primary) 11%, transparent),
			transparent 60%
		);
	}

	.rise {
		transform-origin: left center;
		animation: rise 0.9s cubic-bezier(0.2, 0, 0, 1) both;
	}

	@keyframes rise {
		from {
			transform: scaleX(0);
		}
	}
</style>
