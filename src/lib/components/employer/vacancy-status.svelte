<script lang="ts">
	import { VACANCY_STATUSES, type VacancyStatus } from './model.js';
	import StatusPill from '$lib/components/forms/status-pill.svelte';

	let { status }: { status: VacancyStatus } = $props();

	const tones: Record<VacancyStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
		draft: 'neutral',
		pending_moderation: 'warning',
		published: 'success',
		paused: 'info',
		closed: 'neutral'
	};
</script>

<StatusPill label={VACANCY_STATUSES[status]} tone={tones[status]} />
