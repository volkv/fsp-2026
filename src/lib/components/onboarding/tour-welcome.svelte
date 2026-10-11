<script lang="ts">
	import CompassIcon from '@lucide/svelte/icons/compass';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import type { NavPermission } from '$lib/navigation.js';
	import { tour } from '$lib/onboarding/tour.svelte.js';
	import type { WorkspaceTour } from '$lib/onboarding/types.js';

	/**
	 * The one-time invitation to the tour of the cabinet. Any answer — start, later, closing the window — is
	 * remembered, and the invitation does not come back; the tour stays one click away on the header button.
	 */
	let { workspaceTour, permissions }: { workspaceTour: WorkspaceTour; permissions: readonly NavPermission[] } =
		$props();

	function answer(start: boolean): void {
		tour.mark('welcome');
		tour.welcomeOpen = false;
		if (start) tour.startMain(workspaceTour, permissions);
	}
</script>

<Dialog.Root
	open={tour.welcomeOpen}
	onOpenChange={(open) => {
		if (!open) answer(false);
	}}
>
	<Dialog.Content data-testid="tour-welcome">
		<Dialog.Header>
			<Dialog.Title>{workspaceTour.welcome.title}</Dialog.Title>
			<Dialog.Description>{workspaceTour.welcome.body}</Dialog.Description>
		</Dialog.Header>
		<p class="flex items-center gap-2 text-sm text-muted-foreground">
			<CompassIcon class="size-4 shrink-0" aria-hidden="true" />
			Тур всегда можно открыть кнопкой с компасом справа сверху.
		</p>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => {
					answer(false);
				}}>Позже</Button
			>
			<Button
				onclick={() => {
					answer(true);
				}}>Начать тур</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
