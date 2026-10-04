<script lang="ts">
	import * as Field from '$lib/components/ui/field/index.js';

	/** A refused field shows the refusal; a field the pasted text did not state asks to be filled in. */
	let { problem, toFill }: { problem: string | undefined; toFill: boolean } = $props();
</script>

{#if problem}
	<Field.Error>{problem}</Field.Error>
{:else if toFill}
	<Field.Description class="text-warning">В тексте не указано — заполните</Field.Description>
{/if}
