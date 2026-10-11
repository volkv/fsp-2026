<script lang="ts">
	import CompassIcon from '@lucide/svelte/icons/compass';
	import MapIcon from '@lucide/svelte/icons/map';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { pageTourFor } from '$lib/onboarding/routes.js';
	import { tour } from '$lib/onboarding/tour.svelte.js';
	import { WORKSPACE_TOURS } from '$lib/onboarding/tours/index.js';
	import type { NavPermission, Workspace } from '$lib/navigation.js';

	/**
	 * The tour button of the header: the tour of the page under it and the tour of the cabinet. It pulses while the
	 * tour of this page has not been opened on this device; with reduced motion only the dot stays.
	 */
	let { workspace, permissions }: { workspace: Workspace; permissions: readonly NavPermission[] } = $props();

	const workspaceTour = $derived(WORKSPACE_TOURS[workspace]);
	const pageTour = $derived(pageTourFor(workspaceTour, page.route.id));
	const fresh = $derived(pageTour !== null && !tour.seen(`page:${pageTour.route}`));
	const stops = (count: number): string =>
		`${count} ${count % 10 === 1 && count % 100 !== 11 ? 'шаг' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'шага' : 'шагов'}`;
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				class="relative"
				aria-label="Тур по странице"
				data-tour="tour-button"
				data-fresh={fresh ? '' : undefined}
			>
				{#if fresh}
					<span
						class="tour-pulse pointer-events-none absolute inset-1 rounded-full bg-primary/30 motion-reduce:hidden"
						aria-hidden="true"
					></span>
					<span class="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" aria-hidden="true"></span>
				{/if}
				<CompassIcon aria-hidden="true" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="light w-72">
		{#if pageTour}
			<DropdownMenu.Label>Страница «{pageTour.title}»</DropdownMenu.Label>
			<DropdownMenu.Item
				onSelect={() => {
					tour.startPage(pageTour);
				}}
			>
				<CompassIcon aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate">Тур по этой странице</span>
				<span class="shrink-0 text-xs text-muted-foreground">{stops(pageTour.steps.length)}</span>
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
		{/if}
		<DropdownMenu.Item
			onSelect={() => {
				tour.startMain(workspaceTour, permissions);
			}}
		>
			<MapIcon aria-hidden="true" />
			<span class="min-w-0 flex-1 truncate">Общий тур по кабинету</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<style>
	/* One soft wave every few seconds: a reminder, not a blinking light. */
	.tour-pulse {
		animation: tour-pulse 4.5s cubic-bezier(0, 0, 0.2, 1) infinite;
	}

	@keyframes tour-pulse {
		0% {
			transform: scale(1);
			opacity: 0.8;
		}
		30%,
		100% {
			transform: scale(1.9);
			opacity: 0;
		}
	}
</style>
