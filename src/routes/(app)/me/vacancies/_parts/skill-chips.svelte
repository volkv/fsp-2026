<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import XIcon from '@lucide/svelte/icons/x';
	import { cn } from '$lib/components/utils.js';
	import type { SkillView } from './view.js';

	/** Skills of a vacancy as chips: confirmed in the profile, missing from it, or not known. */
	let { skills, label }: { skills: SkillView[]; label: string } = $props();

	function haveText(skill: SkillView): string {
		return skill.have === true ? 'подтверждён' : skill.have === false ? 'нет в профиле' : 'не известно';
	}
</script>

<ul class="flex flex-wrap gap-1.5" aria-label={label}>
	{#each skills as skill (skill.key)}
		<li
			class={cn(
				'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm whitespace-nowrap',
				skill.have === true && 'border-success/30 bg-success-subtle text-success',
				skill.have === false && 'border-destructive/30 bg-danger-subtle text-destructive',
				skill.have === null && 'border-dashed text-muted-foreground'
			)}
			title={haveText(skill)}
		>
			{#if skill.have === true}
				<CheckIcon class="size-3.5" aria-hidden="true" />
			{:else if skill.have === false}
				<XIcon class="size-3.5" aria-hidden="true" />
			{:else}
				<CircleDashedIcon class="size-3.5" aria-hidden="true" />
			{/if}
			{skill.name}
			<span class="sr-only">— {haveText(skill)}</span>
		</li>
	{/each}
</ul>
