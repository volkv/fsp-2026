<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import MailIcon from '@lucide/svelte/icons/mail';
	import XIcon from '@lucide/svelte/icons/x';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import { pathOf, toneOf } from './score.js';
	import Ring from './score-ring.svelte';
	import type { VacancyCard } from './view.js';

	/** A vacancy of the list in one line: the match, what it is, the required skills and the money. */
	let { item }: { item: VacancyCard } = $props();

	const LIMIT = 4;
	const tone = $derived(toneOf(item.score));
	const required = $derived(item.skills.filter((skill) => skill.required));
</script>

<article
	class="group/row relative grid items-center gap-x-4 gap-y-3 rounded-xl border bg-card p-3 pr-4 shadow-xs transition duration-200 ease-standard hover:border-ring/40 hover:shadow-md sm:grid-cols-[auto_minmax(0,1fr)_auto] lg:grid-cols-[auto_minmax(0,1.1fr)_minmax(0,1fr)_auto]"
>
	<div class="flex min-w-0 items-center gap-3 sm:contents">
		<Ring score={item.score} size={56} stroke={5} />

		<div class="grid min-w-0 gap-0.5">
			<h3 class="line-clamp-2 font-heading text-base leading-snug sm:line-clamp-1">
				<a
					href={pathOf(item.href)}
					class="outline-none after:absolute after:inset-0 hover:underline focus-visible:underline">{item.title}</a
				>
			</h3>
			<p class="flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
				<span class="flex min-w-0 items-center gap-1">
					<span class="truncate">{item.company}</span>
					{#if item.verified}
						<BadgeCheckIcon class="size-3.5 shrink-0 text-link" aria-hidden="true" />
						<span class="sr-only">— компания проверена</span>
					{/if}
				</span>
				<span class="hidden sm:inline" aria-hidden="true">·</span>
				<span class="basis-full sm:basis-auto">{item.grade} · {item.format}</span>
			</p>
			<p class={cn('text-xs font-medium', tone.text)}>
				{tone.label}{#if item.missing.length > 0}<span class="font-normal text-muted-foreground">
						· не хватает {item.missing.length} из {required.length}</span
					>{/if}
			</p>
		</div>
	</div>

	{#if required.length > 0}
		<ul class="hidden flex-wrap gap-1.5 lg:flex" aria-label="Обязательные навыки">
			{#each required.slice(0, LIMIT) as skill (skill.key)}
				<li
					class={cn(
						'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs whitespace-nowrap',
						skill.have === true && 'border-success/30 bg-success-subtle text-success',
						skill.have === false && 'border-destructive/30 bg-danger-subtle text-destructive',
						skill.have === null && 'border-dashed text-muted-foreground'
					)}
				>
					{#if skill.have === true}
						<CheckIcon class="size-3" aria-hidden="true" />
					{:else if skill.have === false}
						<XIcon class="size-3" aria-hidden="true" />
					{:else}
						<CircleDashedIcon class="size-3" aria-hidden="true" />
					{/if}
					{skill.name}
					<span class="sr-only"
						>— {skill.have === true ? 'подтверждён' : skill.have === false ? 'нет в профиле' : 'не известно'}</span
					>
				</li>
			{/each}
			{#if required.length > LIMIT}
				<li class="inline-flex h-6 items-center px-1 text-xs text-muted-foreground">+{required.length - LIMIT}</li>
			{/if}
		</ul>
	{/if}

	<div class="relative flex items-center justify-between gap-4 sm:justify-end">
		<div class="grid text-left sm:text-right">
			{#if item.invitation}
				<a
					href={pathOf(item.invitation.href)}
					class="inline-flex items-center gap-1 text-xs font-medium text-link hover:underline sm:justify-end"
				>
					<MailIcon class="size-3.5" aria-hidden="true" />
					Вас пригласили
				</a>
			{/if}
			<span class={cn('text-sm font-medium numeric', item.salaryText === null && 'font-normal text-muted-foreground')}>
				{item.salaryText ?? 'зарплата не указана'}
			</span>
			{#if item.salaryText !== null && item.salaryPeriod !== null}
				<span class="text-xs text-muted-foreground">{item.salaryPeriod}</span>
			{/if}
		</div>
		<a
			href={pathOf(item.href)}
			class={cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }), 'shrink-0 group-hover/row:border-ring/60')}
			data-testid="vacancy-apply"
			aria-label="Вакансия и отклик: {item.title}"
		>
			<ArrowRightIcon class="transition-transform group-hover/row:translate-x-0.5" aria-hidden="true" />
		</a>
	</div>
</article>
