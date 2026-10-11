<script lang="ts">
	import { page } from '$app/state';
	import { viewerFrom } from '$lib/components/shell/viewer.js';
	import { inCabinet } from '$lib/onboarding/routes.js';
	import { tour } from '$lib/onboarding/tour.svelte.js';
	import { WORKSPACE_TOURS } from '$lib/onboarding/tours/index.js';
	import TourCoach from './tour-coach.svelte';
	import TourWelcome from './tour-welcome.svelte';

	/**
	 * Tours of the signed-in person: who they are for the marks, the one-time invitation on the first page of the
	 * cabinet, and the stop of a running tour. Registration and service pages have no tours.
	 */
	const viewer = $derived(viewerFrom(page.data));
	const workspace = $derived(viewer?.onboardingComplete ? viewer.workspace : null);

	$effect(() => {
		const id = viewer?.id ?? null;
		if (id === null || workspace === null) {
			tour.owner = null;
			tour.close();
			return;
		}
		if (tour.owner?.userId !== id || tour.owner.workspace !== workspace) {
			tour.owner = { userId: id, workspace };
		}
	});

	$effect(() => {
		if (workspace === null || tour.kind !== null || tour.welcomeOpen) return;
		if (inCabinet(workspace, page.url.pathname) && !tour.seen('welcome')) tour.welcomeOpen = true;
	});

	// The tour of a page belongs to that page: leaving it ends the tour. The main tour moves between pages itself.
	let route = page.route.id;
	$effect(() => {
		const current = page.route.id;
		if (current !== route && tour.kind === 'page') tour.close();
		route = current;
	});
</script>

{#if workspace !== null && viewer}
	<TourWelcome workspaceTour={WORKSPACE_TOURS[workspace]} permissions={viewer.permissions} />
	<TourCoach />
{/if}
