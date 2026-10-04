<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import type { AttemptSignals } from './signals.svelte.js';

	/**
	 * A plain code editor: a monospaced textarea where Tab indents instead of leaving the field. No external editor is
	 * loaded, so the page stays within its content security policy and works without scripts (Tab then moves focus).
	 */
	let {
		value = $bindable(''),
		signals,
		id,
		name = 'source',
		describedBy,
		class: className
	}: {
		value?: string;
		signals: AttemptSignals;
		id: string;
		name?: string;
		describedBy?: string;
		class?: string;
	} = $props();

	const INDENT = '\t';

	function onkeydown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
		if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
		event.preventDefault();
		const field = event.currentTarget;
		const { selectionStart, selectionEnd } = field;
		value = value.slice(0, selectionStart) + INDENT + value.slice(selectionEnd);
		const caret = selectionStart + INDENT.length;
		requestAnimationFrame(() => {
			field.setSelectionRange(caret, caret);
		});
	}
</script>

<textarea
	{id}
	{name}
	bind:value
	{onkeydown}
	onpaste={(event) => {
		signals.recordPaste(event);
	}}
	aria-describedby={describedBy}
	spellcheck="false"
	autocapitalize="off"
	autocomplete="off"
	wrap="off"
	rows="22"
	class={cn(
		'min-h-80 w-full resize-y rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-[13px] leading-5 [tab-size:4] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
		className
	)}
	data-testid="code-editor"></textarea>
