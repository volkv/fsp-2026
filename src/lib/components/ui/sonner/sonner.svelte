<script lang="ts">
	import { mode } from 'mode-watcher';
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let { ...restProps }: SonnerProps = $props();
</script>

<!-- Outcomes in the colours of the design: success on light green, a refusal on light red; a little larger than the default. -->
<Sonner
	theme={mode.current}
	class="toaster group"
	richColors
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border); --success-bg: var(--color-success-subtle); --success-text: var(--color-success); --success-border: color-mix(in oklab, var(--color-success) 35%, transparent); --error-bg: var(--color-danger-subtle); --error-text: var(--color-destructive); --error-border: color-mix(in oklab, var(--color-destructive) 35%, transparent);"
	toastOptions={{
		classes: {
			toast: 'cn-toast w-[380px]! gap-2.5! px-5! py-4! text-[15px]! shadow-lg!',
			title: 'font-medium!'
		}
	}}
	{...restProps}
>
	{#snippet loadingIcon()}
		<Loader2Icon class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<CircleCheckIcon class="size-5" />
	{/snippet}
	{#snippet errorIcon()}
		<OctagonXIcon class="size-5" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<TriangleAlertIcon class="size-4" />
	{/snippet}
</Sonner>
