<script lang="ts">
	import '../app.css';
	import { ModeWatcher } from 'mode-watcher';
	import { page } from '$app/state';
	import { AppHeader, SiteFooter } from '$lib/components/shell/index.js';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<!-- The link preview of any page of the stand: the brand card; the landing page adds its title and description. -->
	<meta property="og:site_name" content="ФСП | Карьера" />
	<meta property="og:locale" content="ru_RU" />
	<meta property="og:image" content="{page.url.origin}/og.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="ФСП | Карьера — платформа ИТ-найма, где навыки подтверждены" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<!-- The inline theme script is disabled (the CSP allows only same-origin scripts): static/theme-init.js, loaded in app.html, sets the mode before the first paint. -->
<ModeWatcher defaultMode="system" disableHeadScriptInjection />
<Toaster position="bottom-right" />

<Tooltip.Provider delayDuration={200}>
	<a
		href="#content"
		class="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
	>
		Перейти к содержимому
	</a>
	<div class="flex min-h-dvh flex-col">
		<AppHeader workspace={null} pathname={page.url.pathname} />
		<main id="content" tabindex="-1" class="flex-1 focus:outline-none">
			{@render children()}
		</main>
		<!-- The full footer closes the landing page; the pages of the application keep a single line. -->
		<SiteFooter compact={page.url.pathname !== '/'} />
	</div>
</Tooltip.Provider>
