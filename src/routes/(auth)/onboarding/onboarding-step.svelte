<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';

	let { done, title, text }: { done: boolean; title: string; text: string } = $props();
</script>

<div class="flex gap-3">
	{#if done}
		<CircleCheckIcon class="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
	{:else}
		<CircleDashedIcon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
	{/if}
	<div class="grid gap-1">
		<h2 class="font-medium">
			{title}<span class="sr-only">{done ? ' — готово' : ' — не завершено'}</span>
		</h2>
		<p class="text-sm text-muted-foreground">{text}</p>
	</div>
</div>
