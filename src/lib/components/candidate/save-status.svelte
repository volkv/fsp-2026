<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { fade } from 'svelte/transition';

	/** The state of an autosave shown as a short line; the confirmation fades on its own. */
	let { status }: { status: 'idle' | 'saving' | 'saved' | 'error' } = $props();
</script>

<span
	class="inline-flex min-h-5 items-center text-xs font-normal"
	role="status"
	data-testid="save-status"
	data-state={status}
>
	{#if status === 'saving'}
		<span class="inline-flex items-center gap-1 text-muted-foreground" in:fade={{ duration: 120 }}>
			<LoaderCircleIcon class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
			Сохранение…
		</span>
	{:else if status === 'saved'}
		<span class="inline-flex items-center gap-1 text-success" in:fade={{ duration: 120 }} out:fade={{ duration: 400 }}>
			<CheckIcon class="size-3.5" aria-hidden="true" />
			Сохранено
		</span>
	{:else if status === 'error'}
		<span class="inline-flex items-center gap-1 text-destructive" in:fade={{ duration: 120 }}>
			<CircleAlertIcon class="size-3.5" aria-hidden="true" />
			Не сохранено
		</span>
	{/if}
</span>
