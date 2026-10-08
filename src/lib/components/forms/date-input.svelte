<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * A date field that also spells the chosen day in Russian under itself: the browser draws the field in the format of
	 * its own locale (`mm/dd/yyyy` in an English one), the caption always reads «17 апреля 1999 г.».
	 */
	let { value = $bindable(''), ...rest }: Omit<HTMLInputAttributes, 'type' | 'value' | 'files'> & { value?: string } =
		$props();

	const spelling = new Intl.DateTimeFormat('ru-RU', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const spelled = $derived(/^\d{4}-\d{2}-\d{2}$/.test(value) ? spelling.format(new Date(`${value}T00:00:00Z`)) : null);
</script>

<Input type="date" bind:value {...rest} />
{#if spelled}
	<p class="text-xs text-muted-foreground" data-testid="date-spelled">{spelled}</p>
{/if}
