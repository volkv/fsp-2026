<script module lang="ts">
	export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
</script>

<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { fade } from 'svelte/transition';
	import { Input } from '$lib/components/ui/input/index.js';
	import { cn } from '$lib/components/utils.js';

	/** A text field saved on its own: inside it on the right — the saving, then the tick that fades, or the refusal. */
	let {
		status,
		class: className,
		...rest
	}: Omit<HTMLInputAttributes, 'type' | 'files' | 'value'> & {
		type?: 'text' | 'tel';
		value?: string | null;
		status: SaveState;
	} = $props();
</script>

<div class="relative">
	<Input class={cn('pr-9', className)} {...rest} />
	<span
		class="pointer-events-none absolute inset-y-0 right-3 flex items-center"
		role="status"
		data-testid="field-save"
		data-state={status}
	>
		{#if status === 'saving'}
			<LoaderCircleIcon
				class="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
				aria-hidden="true"
			/>
			<span class="sr-only">Сохранение</span>
		{:else if status === 'saved'}
			<span class="flex items-center" in:fade={{ duration: 120 }} out:fade={{ duration: 400 }}>
				<CheckIcon class="size-4 text-success" aria-hidden="true" />
				<span class="sr-only">Сохранено</span>
			</span>
		{:else if status === 'error'}
			<CircleAlertIcon class="size-4 text-destructive" aria-hidden="true" />
			<span class="sr-only">Не сохранено</span>
		{/if}
	</span>
</div>
