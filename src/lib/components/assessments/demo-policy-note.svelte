<script lang="ts">
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';

	/** The grade policy is lifted in a demo session: said on every screen of tests there, with what it is outside. */
	let { text }: { text: string } = $props();
</script>

<p
	class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle p-3 text-sm"
	data-testid="demo-policy-note"
>
	<FlaskConicalIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	<span>{text}</span>
</p>
