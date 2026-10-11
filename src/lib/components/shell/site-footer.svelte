<script lang="ts">
	import { resolve } from '$app/paths';
	import BrandStrip from '$lib/components/brand/brand-strip.svelte';
	import FspLogo from '$lib/components/brand/fsp-logo.svelte';
	import { cn } from '$lib/components/utils.js';
	import { PUBLIC_NAV, SIGN_IN_HREF } from '$lib/navigation.js';

	/**
	 * The site footer: under the landing page the full one, in the colours of its header plate (the theme opposite to the
	 * page's); under the pages of the application a single line on the page background (`compact`).
	 */
	let { compact = false }: { compact?: boolean } = $props();

	const platform = [
		{ label: 'Как это работает', href: resolve('/#how') },
		{ label: 'Войти через ФСП ID', href: resolve(SIGN_IN_HREF) }
	];
	const link = 'text-muted-foreground transition-colors duration-300 hover:text-foreground';
</script>

<footer
	class={cn('border-t text-foreground', compact ? 'bg-background' : 'bg-header')}
	data-theme-inverse={compact ? undefined : ''}
>
	{#if compact}
		<div class="mx-auto max-w-7xl px-4 py-6 sm:px-6">
			<BrandStrip class="h-3" />
			<div
				class="mt-5 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
			>
				<p class="flex items-center gap-3">
					<FspLogo class="h-6" title="ФСП" />
					<span>Карьера — платформа ИТ-найма, где навыки подтверждены</span>
				</p>
				<p>Прототип для Федерации спортивного программирования России</p>
			</div>
		</div>
	{:else}
		<div class="mx-auto max-w-7xl px-4 pt-16 pb-10 sm:px-6 lg:pt-24">
			<div
				class="grid grid-cols-2 gap-x-6 gap-y-12 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-16"
			>
				<div class="col-span-2 lg:col-span-1">
					<FspLogo class="h-10" title="ФСП" />
					<p class="mt-8 max-w-md font-heading text-xl leading-snug font-medium text-balance sm:text-2xl">
						Карьера — платформа ИТ-найма, где навыки подтверждены
					</p>
				</div>
				<nav aria-label="Для кого">
					<p class="font-mono text-label text-muted-foreground uppercase">Для кого</p>
					<ul class="mt-6 space-y-4">
						{#each PUBLIC_NAV as item (item.href)}
							<li><a href={item.href} class={link}>{item.label}</a></li>
						{/each}
					</ul>
				</nav>
				<nav aria-label="Платформа">
					<p class="font-mono text-label text-muted-foreground uppercase">Платформа</p>
					<ul class="mt-6 space-y-4">
						{#each platform as item (item.href)}
							<li><a href={item.href} class={link}>{item.label}</a></li>
						{/each}
					</ul>
				</nav>
			</div>
			<BrandStrip class="mt-16 h-4 lg:mt-24" />
			<div
				class="mt-8 flex flex-col gap-2 border-t pt-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
			>
				<p>ФСП | Карьера</p>
				<p>Прототип для Федерации спортивного программирования России</p>
			</div>
		</div>
	{/if}
</footer>
