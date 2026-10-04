<script lang="ts">
	import { resolve } from '$app/paths';
	import FspSign from '$lib/components/brand/fsp-sign.svelte';
	import { cn } from '$lib/components/utils.js';

	/** «Sign + ФСП | product» lock-up, the pattern of the FSP athlete cabinet and FSP ID. */
	let { class: className }: { class?: string } = $props();
</script>

<a
	href={resolve('/')}
	class={cn(
		'inline-flex items-center gap-2.5 rounded-md font-heading text-base font-medium whitespace-nowrap',
		className
	)}
	aria-label="ФСП | Карьера — на главную"
>
	<FspSign class="size-8" />
	<span aria-hidden="true">ФСП <span class="text-muted-foreground">|</span> Карьера</span>
</a>
