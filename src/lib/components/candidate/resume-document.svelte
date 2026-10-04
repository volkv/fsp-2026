<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import type { BlockKind, BlockView } from './quotes';

	/**
	 * The text of the resume block by block, with every quote a field rests on marked; the quotes of the selected field
	 * stand out. The container scrolls on its own, so a click on a field brings its words into view next to it.
	 */
	let {
		blocks,
		selected,
		element = $bindable(null),
		labelledby
	}: {
		blocks: BlockView[];
		/** Source key of the field whose quotes are shown. */
		selected: string | null;
		element?: HTMLElement | null;
		labelledby: string;
	} = $props();

	const KIND_CLASSES: Record<BlockKind, string> = {
		heading: 'mt-3 font-semibold first:mt-0',
		paragraph: '',
		list_item: 'pl-3',
		table_cell: '',
		line: ''
	};

	const startsPage = (index: number) => {
		const page = blocks[index]?.page ?? null;
		return index > 0 && page !== null && page !== (blocks[index - 1]?.page ?? null);
	};
</script>

<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={element}
	role="region"
	aria-labelledby={labelledby}
	tabindex="0"
	class="grid max-h-[70vh] content-start gap-1.5 overflow-y-auto rounded-lg border bg-background p-4 text-sm leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
	data-testid="resume-text"
>
	{#each blocks as block, index (block.id)}
		{#if startsPage(index)}
			<p class="mt-2 border-t pt-2 text-xs text-muted-foreground">Страница {block.page}</p>
		{/if}
		<p class={cn('break-words whitespace-pre-wrap', KIND_CLASSES[block.kind])} data-block={block.id}>
			{#each block.segments as segment, position (position)}
				{#if segment.keys.length === 0}{segment.text}{:else}<mark
						tabindex="-1"
						data-sources={segment.keys.join(' ')}
						data-selected={selected !== null && segment.keys.includes(selected) ? 'true' : undefined}
						class={cn(
							'rounded-sm bg-info-subtle text-foreground underline decoration-info/50 underline-offset-2 outline-none',
							selected !== null &&
								segment.keys.includes(selected) &&
								'bg-warning-subtle decoration-transparent ring-2 ring-warning'
						)}>{segment.text}</mark
					>{/if}
			{/each}
		</p>
	{/each}
</div>
