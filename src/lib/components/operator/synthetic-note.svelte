<script lang="ts">
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import { cn } from '$lib/components/utils.js';

	/** The numbers include seeded demo records: the page says so next to them, not in a footnote. */
	let { compact = false, class: className }: { compact?: boolean; class?: string } = $props();
</script>

{#if compact}
	<span
		class={cn(
			'inline-flex h-5 items-center gap-1 rounded-full border border-info/30 bg-info-subtle px-2 text-xs font-medium text-info',
			className
		)}
		data-synthetic
	>
		<FlaskConicalIcon class="size-3" aria-hidden="true" />
		синтетика
	</span>
{:else}
	<p
		class={cn(
			'flex items-start gap-2 rounded-lg border border-info/30 bg-info-subtle p-3 text-sm text-info',
			className
		)}
		data-synthetic
	>
		<FlaskConicalIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span>
			<span class="font-medium">Синтетика.</span> В числах есть демонстрационные записи: люди, компании и исходы найма сгенерированы
			на реальных соревнованиях ФСП.
		</span>
	</p>
{/if}
