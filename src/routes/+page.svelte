<script lang="ts">
	import { page } from '$app/state';
	import { DESCRIPTION, landingMetrics } from '$lib/components/landing/content.js';
	import LandingPage from '$lib/components/landing/landing-page.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const title = 'ФСП | Карьера — платформа ИТ-найма, где навыки подтверждены';
	const metrics = $derived(landingMetrics(data.metrics));
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={DESCRIPTION} />
	<meta property="og:type" content="website" />
	<meta property="og:url" content="{page.url.origin}/" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={DESCRIPTION} />
</svelte:head>

<LandingPage {metrics} />
