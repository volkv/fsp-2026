<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { cn } from '$lib/components/utils.js';

	/** Outcome of a form: a refusal of the service or a confirmation, announced to screen readers. */
	let {
		tone = 'error',
		text,
		class: className
	}: { tone?: 'error' | 'success'; text: string; class?: string } = $props();
</script>

<Alert.Root
	variant={tone === 'error' ? 'destructive' : 'default'}
	role={tone === 'error' ? 'alert' : 'status'}
	data-tone={tone}
	class={cn(tone === 'success' && 'border-success/40 bg-success-subtle', className)}
>
	{#if tone === 'error'}
		<CircleAlertIcon aria-hidden="true" />
	{:else}
		<CircleCheckIcon aria-hidden="true" class="text-success" />
	{/if}
	<Alert.Description>{text}</Alert.Description>
</Alert.Root>
