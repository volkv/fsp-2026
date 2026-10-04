<script lang="ts">
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import { homeHref, WORKSPACES } from '$lib/navigation.js';
	import { CSRF_FIELD, type Viewer } from './viewer.js';

	interface Props {
		viewer: Viewer;
		/** Stacked for the narrow-screen menu. */
		vertical?: boolean;
	}

	let { viewer, vertical = false }: Props = $props();
</script>

<div class={cn('flex gap-1', vertical ? 'flex-col items-stretch' : 'items-center')}>
	<a
		href={homeHref(viewer.onboardingComplete)}
		class={cn(buttonVariants({ variant: 'ghost' }), vertical ? 'justify-start' : 'max-w-56')}
		data-testid="viewer-link"
	>
		<UserRoundIcon aria-hidden="true" />
		<span class="truncate">{viewer.displayName}</span>
		{#if viewer.workspace}
			<span class="sr-only">— {WORKSPACES[viewer.workspace].label.toLowerCase()}</span>
		{/if}
	</a>
	<form method="POST" action={resolve('/auth/logout')}>
		<input type="hidden" name={CSRF_FIELD} value={viewer.csrfToken} />
		<button type="submit" class={cn(buttonVariants({ variant: 'outline' }), vertical && 'w-full')}>
			<LogOutIcon aria-hidden="true" />
			Выйти
		</button>
	</form>
</div>
