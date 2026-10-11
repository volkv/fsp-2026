<script lang="ts">
	import SendIcon from '@lucide/svelte/icons/send';
	import { SalaryRange, TrustChip } from '$lib/components/product/index.js';
	import type { TrustLevel } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';

	/** The floating product shot of the first screen: a sample candidate profile and an offer to it. Sample data. */
	let { class: className }: { class?: string } = $props();

	const skills: { skill: string; level: TrustLevel }[] = [
		{ skill: 'Алгоритмы', level: 'fsp_verified' },
		{ skill: 'Go', level: 'platform_verified' },
		{ skill: 'PostgreSQL', level: 'public_verifiable' },
		{ skill: 'Kubernetes', level: 'claimed' }
	];
</script>

<figure
	class={cn(
		'rounded-[2rem] border bg-card p-5 text-card-foreground shadow-[0_40px_120px_-30px_rgb(64_47_255/0.45)] sm:p-9 dark:border-white/12',
		className
	)}
	aria-label="Пример профиля кандидата и предложения работодателя"
>
	<div class="flex flex-wrap items-center gap-4">
		<span
			class="flex size-12 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand-400 to-brand-700 font-heading text-base font-medium text-white sm:size-14"
			aria-hidden="true">АК</span
		>
		<div class="min-w-0 flex-1">
			<p class="truncate font-heading text-lg font-medium sm:text-xl">Анна К.</p>
			<p class="text-sm text-muted-foreground">Пример профиля</p>
		</div>
		<div class="w-full rounded-2xl border px-4 py-2 sm:w-auto sm:text-right">
			<p class="font-mono text-label text-muted-foreground uppercase">Категория по тесту</p>
			<p class="font-heading text-base font-medium">Backend · Middle</p>
		</div>
	</div>

	<ul class="mt-7 flex flex-wrap gap-2" aria-label="Навыки и чем они подтверждены">
		{#each skills as item (item.skill)}
			<li><TrustChip skill={item.skill} level={item.level} size="md" signal /></li>
		{/each}
	</ul>

	<div
		class="mt-7 flex flex-col gap-5 rounded-3xl border border-primary/25 bg-accent p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6 dark:border-brand-400/40"
	>
		<div class="space-y-2">
			<p class="flex items-center gap-2 font-mono text-label text-accent-foreground uppercase">
				<SendIcon class="size-3.5" aria-hidden="true" />
				Работодатель пишет первым
			</p>
			<SalaryRange
				salary={{ min: 260_000, max: 320_000, currency: 'RUB', period: 'month', taxBase: 'gross' }}
				size="lg"
			/>
		</div>
		<p class="max-w-56 text-sm text-muted-foreground sm:text-right">Почему вы: призёр ФСП и тест платформы по Go</p>
	</div>
	<figcaption class="sr-only">Имя, навыки и вилка — пример, не реальные данные.</figcaption>
</figure>
