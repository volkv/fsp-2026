<script lang="ts">
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { cn } from '$lib/components/utils.js';
	import {
		LOGIN_HREF,
		PUBLIC_NAV,
		SIGN_IN_HREF,
		WORKSPACES,
		permittedItems,
		type NavItem,
		type Workspace
	} from '$lib/navigation.js';
	import BrandLockup from './brand-lockup.svelte';
	import DemoSessionBadge from './demo-session-badge.svelte';
	import NavLinks from './nav-links.svelte';
	import ThemeToggle from './theme-toggle.svelte';
	import UserMenu from './user-menu.svelte';
	import { viewerFrom } from './viewer.js';
	import WorkspaceNav from './workspace-nav.svelte';

	interface Props {
		/**
		 * Workspace whose sections are shown; `null` — the workspace of the signed-in person, or the public header for
		 * a visitor. The showcase passes one explicitly.
		 */
		workspace: Workspace | null;
		pathname: string;
		class?: string;
	}

	let { workspace: shownWorkspace, pathname, class: className }: Props = $props();

	/** The signed-in person comes with the layout data of the page (`viewer`). */
	const viewer = $derived(viewerFrom(page.data));
	const workspace = $derived(shownWorkspace ?? viewer?.workspace ?? null);

	let menuOpen = $state(false);

	function closeMenu(): void {
		menuOpen = false;
	}

	/** Sections of the workspace, less those behind a permission the viewer does not hold; the same list on every width. */
	const items: NavItem[] = $derived(
		workspace ? permittedItems(WORKSPACES[workspace].items, viewer?.permissions ?? []) : PUBLIC_NAV
	);
	const navLabel = $derived(workspace ? `Разделы: ${WORKSPACES[workspace].label.toLowerCase()}` : 'Основная навигация');
</script>

<header
	class={cn('sticky top-0 z-40 border-b bg-header/95 backdrop-blur supports-backdrop-filter:bg-header/80', className)}
>
	<div class="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
		<BrandLockup />
		{#if workspace}
			<span class="hidden rounded-full border px-2 py-0.5 text-xs text-muted-foreground lg:inline">
				{WORKSPACES[workspace].label}
			</span>
		{/if}
		{#if viewer?.demoSession}
			<DemoSessionBadge expiresAt={viewer.demoSession.expiresAt} compact class="hidden sm:inline-flex" />
			<a
				href={resolve('/demo/mail')}
				class={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'hidden sm:inline-flex')}
				data-testid="demo-mail-link"
			>
				<MailIcon aria-hidden="true" />
				<span class="max-lg:sr-only">Письма сессии</span>
			</a>
		{/if}
		{#if !workspace}
			<nav class="ml-4 hidden md:block" aria-label={navLabel}>
				<NavLinks {items} {pathname} />
			</nav>
		{/if}
		<div class="ml-auto flex items-center gap-1">
			<ThemeToggle />
			{#if viewer}
				<div class="hidden sm:block">
					<UserMenu {viewer} />
				</div>
			{:else if !workspace}
				<a href={resolve(LOGIN_HREF)} class={cn(buttonVariants({ variant: 'outline' }), 'hidden sm:inline-flex')}>
					Войти
				</a>
				<a
					href={resolve(SIGN_IN_HREF)}
					class={cn(buttonVariants(), 'hidden sm:inline-flex')}
					data-sveltekit-reload
					data-sveltekit-preload-data="off"
				>
					<LogInIcon aria-hidden="true" />
					Войти через ФСП ID
				</a>
			{/if}
			<Sheet.Root bind:open={menuOpen}>
				<Sheet.Trigger
					class={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'md:hidden')}
					aria-label="Открыть меню"
				>
					<MenuIcon aria-hidden="true" />
				</Sheet.Trigger>
				<Sheet.Content side="left" class="w-72 gap-0">
					<Sheet.Header>
						<Sheet.Title>ФСП | Карьера</Sheet.Title>
						<Sheet.Description>
							{workspace ? WORKSPACES[workspace].label : 'Платформа ИТ-найма, где навыки подтверждены'}
						</Sheet.Description>
					</Sheet.Header>
					<nav class="px-4" aria-label={navLabel}>
						<NavLinks {items} {pathname} vertical onnavigate={closeMenu} />
					</nav>
					<div class="mt-4 grid gap-2 px-4">
						{#if viewer?.demoSession}
							<DemoSessionBadge expiresAt={viewer.demoSession.expiresAt} class="justify-self-start" />
							<a
								href={resolve('/demo/mail')}
								class={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
								onclick={closeMenu}
							>
								<MailIcon aria-hidden="true" />
								Письма сессии
							</a>
						{/if}
						{#if viewer}
							<UserMenu {viewer} vertical />
						{:else if !workspace}
							<a
								href={resolve(SIGN_IN_HREF)}
								class={cn(buttonVariants(), 'w-full')}
								data-sveltekit-reload
								data-sveltekit-preload-data="off"
							>
								<LogInIcon aria-hidden="true" />
								Войти через ФСП ID
							</a>
							<a href={resolve(LOGIN_HREF)} class={cn(buttonVariants({ variant: 'outline' }), 'w-full')}>
								Войти по почте
							</a>
						{/if}
					</div>
				</Sheet.Content>
			</Sheet.Root>
		</div>
	</div>
	{#if workspace}
		<div class="hidden border-t md:block">
			<div class="mx-auto max-w-7xl px-4 sm:px-6">
				<WorkspaceNav {items} {pathname} label={navLabel} />
			</div>
		</div>
	{/if}
</header>
