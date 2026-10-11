<script lang="ts">
	import { resolve } from '$app/paths';
	import Radar from './_parts/radar.svelte';
	import { vacanciesView } from './_parts/view.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const view = $derived(
		vacanciesView(data, {
			base: resolve('/me/vacancies'),
			vacancy: (id) => resolve('/(app)/me/vacancies/[id]', { id }),
			invitation: (id) => resolve('/(app)/me/invitations/[id]', { id }),
			applications: resolve('/me/applications'),
			profile: resolve('/me/profile')
		})
	);
</script>

<Radar {view} />
