<script lang="ts">
	import ParamValue from './param-value.svelte';

	/** A parameter of a rule set or a policy as stored: scalars as text, lists inline, objects as nested terms. */
	let { value }: { value: unknown } = $props();

	type Scalar = string | number | boolean | null;
	const isScalar = (item: unknown): item is Scalar =>
		item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean';
	const text = (item: Scalar) =>
		item === null ? '—' : typeof item === 'boolean' ? (item ? 'да' : 'нет') : String(item);
	const entries = $derived(
		typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : null
	);
</script>

{#if isScalar(value)}
	<span class="font-mono text-xs break-words">{text(value)}</span>
{:else if Array.isArray(value) && value.every(isScalar)}
	<span class="font-mono text-xs break-words">{value.length === 0 ? '[]' : value.map(text).join(', ')}</span>
{:else if Array.isArray(value)}
	<ol class="grid list-decimal gap-1 pl-5">
		{#each value as item, index (index)}
			<li><ParamValue value={item} /></li>
		{/each}
	</ol>
{:else if entries}
	<dl class="grid gap-1 border-l pl-3">
		{#each entries as [key, item] (key)}
			<div class="grid gap-x-3 sm:grid-cols-[minmax(8rem,auto)_1fr]">
				<dt class="font-mono text-xs text-muted-foreground">{key}</dt>
				<dd><ParamValue value={item} /></dd>
			</div>
		{/each}
	</dl>
{/if}
