<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SearchIcon from '@lucide/svelte/icons/search';
	import FspSign from '$lib/components/brand/fsp-sign.svelte';
	import { TrustChip } from '$lib/components/product/index.js';
	import { TRUST, type TrustLevel } from '$lib/components/product/model.js';
	import { TRUST_LADDER, type Audience } from './content.js';

	/** The picture beside each audience block of the keynote layout; sample data where a person or a figure is shown. */
	let { audience }: { audience: Audience['id'] } = $props();

	const shortlist: { initials: string; match: number; skill: string; level: TrustLevel }[] = [
		{ initials: 'АК', match: 92, skill: 'Go', level: 'fsp_verified' },
		{ initials: 'ИС', match: 84, skill: 'Go', level: 'platform_verified' },
		{ initials: 'МЛ', match: 71, skill: 'Go', level: 'public_verifiable' }
	];

	const stages = ['Предложения компаний', 'Контакты', 'Собеседования', 'Выходы'];
</script>

<div
	class="relative isolate overflow-hidden rounded-[2rem] border bg-card p-6 shadow-lg sm:p-10"
	data-keynote-visual={audience}
>
	<div
		class="pointer-events-none absolute -bottom-48 left-1/2 -z-10 size-80 -translate-x-1/2 rounded-full bg-brand-500/10 blur-3xl dark:bg-brand-500/20"
		aria-hidden="true"
	></div>

	{#if audience === 'employers'}
		<p class="flex items-center gap-3 rounded-2xl border bg-background px-4 py-3 text-sm">
			<SearchIcon class="size-4 shrink-0 text-link" aria-hidden="true" />
			<span>Нужен бэкенд-разработчик на Go, middle</span>
		</p>
		<ArrowDownIcon class="mx-auto my-4 size-5 text-muted-foreground" aria-hidden="true" />
		<ul class="space-y-3" aria-label="Пример подборки">
			{#each shortlist as row (row.initials)}
				<li class="flex items-center gap-3 rounded-2xl border bg-background px-4 py-3">
					<span
						class="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent font-heading text-xs text-accent-foreground"
						aria-hidden="true">{row.initials}</span
					>
					<span class="min-w-0 flex-1">
						<span class="block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
							<span class="block h-full rounded-full bg-primary" style:width="{row.match}%"></span>
						</span>
						<span class="mt-1.5 block font-mono text-xs text-muted-foreground">соответствие {row.match}%</span>
					</span>
					<TrustChip skill={row.skill} level={row.level} class="hidden sm:inline-flex" />
				</li>
			{/each}
		</ul>
		<div
			class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-primary px-5 py-4 text-primary-foreground"
		>
			<span class="font-mono text-label uppercase">Предложение</span>
			<span class="font-heading text-lg font-medium numeric">260 000 – 320 000 ₽</span>
		</div>
		<p class="mt-4 text-center text-xs text-muted-foreground">Пример: имена и вилка условные</p>
	{:else if audience === 'candidates'}
		<p class="font-mono text-label text-muted-foreground uppercase">Каждый навык подписан</p>
		<ol class="relative mt-6 space-y-5">
			<span class="absolute top-3 bottom-3 left-3.5 w-px bg-border" aria-hidden="true"></span>
			{#each TRUST_LADDER as level (level)}
				<li class="relative flex min-w-0 items-center gap-4 pl-10">
					<span
						class="absolute left-2 size-3 rounded-full border-2 border-primary bg-card"
						class:bg-primary={TRUST[level].nodes === 3}
						aria-hidden="true"
					></span>
					<TrustChip {level} size="md" signal />
				</li>
			{/each}
		</ol>
		<div class="mt-8 rounded-2xl border bg-background p-4">
			<p class="font-mono text-label text-muted-foreground uppercase">Категория — только по тесту</p>
			<p class="mt-1 font-heading text-xl font-medium">Backend · Middle</p>
		</div>
	{:else}
		<div class="flex items-center gap-4">
			<FspSign class="size-14" />
			<p class="font-mono text-label text-muted-foreground uppercase">Карьерный путь по стадиям</p>
		</div>
		<ul class="mt-8 space-y-4">
			{#each stages as stage, index (stage)}
				<li>
					<span class="text-sm">{stage}</span>
					<span class="mt-1.5 block h-3 overflow-hidden rounded-full bg-muted" aria-hidden="true">
						<span
							class="block h-full rounded-full bg-linear-to-r from-brand-500 to-brand-300"
							style:width="{100 - index * 22}%"
						></span>
					</span>
				</li>
			{/each}
		</ul>
		<p class="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
			<span class="size-2 rounded-full bg-brand-red" aria-hidden="true"></span>
			Схема: доли условные
		</p>
	{/if}
</div>
