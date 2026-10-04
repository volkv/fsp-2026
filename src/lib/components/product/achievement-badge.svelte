<script lang="ts">
	import BinaryIcon from '@lucide/svelte/icons/binary';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import PlaneIcon from '@lucide/svelte/icons/plane';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import UsersIcon from '@lucide/svelte/icons/users';
	import WifiIcon from '@lucide/svelte/icons/wifi';
	import { cn } from '$lib/components/utils.js';
	import {
		AWARDS,
		COMPETITION_FORMATS,
		COMPETITION_LEVELS,
		DISCIPLINES,
		EVSK_RANKS,
		type AchievementView
	} from './model.js';

	let { achievement, class: className }: { achievement: AchievementView; class?: string } = $props();

	const disciplineIcons = {
		algorithmic: BinaryIcon,
		product: BoxesIcon,
		infosec: ShieldCheckIcon,
		robotics: BotIcon,
		uas: PlaneIcon,
		unknown: TrophyIcon
	} as const;

	const Icon = $derived(disciplineIcons[achievement.discipline]);
	const FormatIcon = $derived(achievement.format === 'online' ? WifiIcon : MapPinIcon);
	const place = $derived(achievement.exact?.place ?? null);
	const podium = $derived(achievement.award === 'winner' || achievement.award === 'prize');
</script>

<article
	class={cn(
		'relative flex gap-3 overflow-hidden rounded-xl border bg-card p-4 text-card-foreground shadow-xs',
		podium && 'border-brand-300 dark:border-brand-400',
		className
	)}
	aria-label="Достижение ФСП: {AWARDS[achievement.award]}, {DISCIPLINES[achievement.discipline]
		.short}, {achievement.season}"
	data-award={achievement.award}
>
	<div
		class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"
		aria-hidden="true"
	>
		<Icon class="size-5" />
	</div>
	<div class="min-w-0 flex-1 space-y-1.5">
		<p class="font-mono text-label text-muted-foreground uppercase">
			{DISCIPLINES[achievement.discipline].short} · {achievement.season}
		</p>
		<p class="flex flex-wrap items-baseline gap-x-2 font-heading text-base font-medium">
			{#if place !== null}
				<span class="text-h3 text-link numeric">{place}</span>
				<span>место{achievement.exact?.placeOf ? ` из ${achievement.exact.placeOf}` : ''}</span>
				<span class="text-sm text-muted-foreground">· {AWARDS[achievement.award]}</span>
			{:else}
				<span>{AWARDS[achievement.award]}</span>
			{/if}
		</p>
		<p class="text-sm">
			{achievement.exact?.competition ?? COMPETITION_LEVELS[achievement.level]}
		</p>
		<ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
			<li class="inline-flex items-center gap-1">
				<FormatIcon class="size-3.5" aria-hidden="true" />{COMPETITION_FORMATS[achievement.format]}
			</li>
			<li class="inline-flex items-center gap-1">
				<UsersIcon class="size-3.5" aria-hidden="true" />
				{achievement.team
					? `Командный зачёт${achievement.exact?.teamName ? ` · «${achievement.exact.teamName}»` : ''}`
					: 'Личный зачёт'}
			</li>
			{#if achievement.evskIndicator}
				<li>Соответствует нормам {EVSK_RANKS[achievement.evskIndicator]} (расчётно по ЕВСК)</li>
			{/if}
		</ul>
	</div>
</article>
