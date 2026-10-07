<script lang="ts">
	import { resolve } from '$app/paths';
	import FspLogo from '$lib/components/brand/fsp-logo.svelte';
	import { cn } from '$lib/components/utils.js';

	/**
	 * «ФСП | product» lock-up, the pattern of the FSP athlete cabinet and FSP ID: the official short logo, a bar and the
	 * product name in the heading face, its capitals level with the lettering of the logo.
	 */
	let { class: className }: { class?: string } = $props();
</script>

<a
	href={resolve('/')}
	class={cn(
		'inline-flex items-center gap-2.5 rounded-md font-heading text-xl leading-none font-medium whitespace-nowrap',
		className
	)}
	aria-label="ФСП | Карьера — на главную"
>
	<FspLogo class="h-7" />
	<span aria-hidden="true"><span class="text-muted-foreground">|</span> Карьера</span>
</a>
