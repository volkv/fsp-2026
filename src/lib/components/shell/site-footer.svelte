<script lang="ts">
	import { resolve } from '$app/paths';
	import BrandStrip from '$lib/components/brand/brand-strip.svelte';
	import FspLogo from '$lib/components/brand/fsp-logo.svelte';
	import { PUBLIC_NAV, SIGN_IN_HREF } from '$lib/navigation.js';

	/** The site footer: dark in both themes, as the brand blocks of the landing page. */
	const platform = [
		{ label: 'Как это работает', href: resolve('/#how') },
		{ label: 'Войти через ФСП ID', href: resolve(SIGN_IN_HREF) }
	];
	const link = 'text-ink-150 transition-colors duration-300 hover:text-white';
</script>

<footer class="dark border-t border-white/10 bg-black text-foreground">
	<div class="mx-auto max-w-7xl px-4 pt-16 pb-10 sm:px-6 lg:pt-24">
		<div class="grid grid-cols-2 gap-x-6 gap-y-12 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
			<div class="col-span-2 lg:col-span-1">
				<FspLogo class="h-10" title="ФСП" />
				<p class="mt-8 max-w-md font-heading text-xl leading-snug font-medium text-balance text-ink-50 sm:text-2xl">
					Карьера — платформа ИТ-найма, где навыки подтверждены
				</p>
			</div>
			<nav aria-label="Для кого">
				<p class="font-mono text-label text-ink-250 uppercase">Для кого</p>
				<ul class="mt-6 space-y-4">
					{#each PUBLIC_NAV as item (item.href)}
						<li><a href={item.href} class={link}>{item.label}</a></li>
					{/each}
				</ul>
			</nav>
			<nav aria-label="Платформа">
				<p class="font-mono text-label text-ink-250 uppercase">Платформа</p>
				<ul class="mt-6 space-y-4">
					{#each platform as item (item.href)}
						<li><a href={item.href} class={link}>{item.label}</a></li>
					{/each}
				</ul>
			</nav>
		</div>
		<BrandStrip class="mt-16 h-4 lg:mt-24" />
		<div
			class="mt-8 flex flex-col gap-2 border-t border-white/10 pt-8 text-sm text-ink-250 sm:flex-row sm:items-center sm:justify-between"
		>
			<p>ФСП | Карьера</p>
			<p>Прототип для Федерации спортивного программирования России</p>
		</div>
	</div>
</footer>
