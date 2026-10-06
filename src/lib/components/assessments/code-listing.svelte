<script lang="ts">
	/**
	 * The code of a task. Numbered — for a task answered by a line number — as a list whose numbers are the lines of the
	 * source from 1, the numbering the generator counts the answer in; the numbers are list markers, so a copy of the
	 * code does not carry them.
	 */
	let { code, numbered, testId }: { code: { language: string; source: string }; numbered: boolean; testId?: string } =
		$props();

	const lines = $derived(code.source.split('\n'));
</script>

{#if numbered}
	<ol
		class="list-decimal overflow-x-auto rounded-lg bg-muted py-3 pr-3 pl-12 font-mono text-xs leading-5 [tab-size:4] marker:text-muted-foreground"
		data-language={code.language}
		data-testid={testId}
		aria-label="Код, строки пронумерованы с 1"
	>
		{#each lines as line, index (index)}
			<li class="min-h-5 pl-2 whitespace-pre">{line}</li>
		{/each}
	</ol>
{:else}
	<pre
		class="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5 [tab-size:4]"
		data-language={code.language}
		data-testid={testId}>{code.source}</pre>
{/if}
