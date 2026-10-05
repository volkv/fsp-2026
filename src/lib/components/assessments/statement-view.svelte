<script lang="ts">
	import type { StatementBlock } from './model.js';
	import StatementInlines from './statement-inlines.svelte';

	/** A task statement from its blocks: elements only, no HTML from the bank. */
	let { blocks }: { blocks: StatementBlock[] } = $props();
</script>

<div class="grid gap-3 text-sm leading-relaxed" data-testid="statement">
	{#each blocks as block, index (index)}
		{#if block.kind === 'heading'}
			<h3 class="mt-2 font-heading text-base font-semibold">{block.text}</h3>
		{:else if block.kind === 'paragraph'}
			<p><StatementInlines parts={block.inlines} /></p>
		{:else if block.kind === 'code'}
			<pre
				class="rounded-lg bg-muted p-3 font-mono text-xs leading-snug break-words whitespace-pre-wrap">{block.text}</pre>
		{:else if block.kind === 'table'}
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-xs">
					<thead>
						<tr class="border-b">
							{#each block.header as cell, column (column)}
								<th class="px-2 py-1 font-semibold"><StatementInlines parts={cell} /></th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each block.rows as row, position (position)}
							<tr class="border-b align-top last:border-b-0">
								{#each row as cell, column (column)}
									<td class="px-2 py-1"><StatementInlines parts={cell} /></td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if block.ordered}
			<ol class="grid list-decimal gap-1 pl-5">
				{#each block.items as item, position (position)}
					<li><StatementInlines parts={item} /></li>
				{/each}
			</ol>
		{:else}
			<ul class="grid list-disc gap-1 pl-5">
				{#each block.items as item, position (position)}
					<li><StatementInlines parts={item} /></li>
				{/each}
			</ul>
		{/if}
	{/each}
</div>
