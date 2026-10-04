<script lang="ts">
	import BaseSection from './base-section.svelte';
	import ProductSection from './product-section.svelte';
	import ShellSection from './shell-section.svelte';
	import TokensSection from './tokens-section.svelte';

	const contents = [
		{ id: 'tokens', label: 'Токены' },
		{ id: 'base', label: 'Базовые компоненты' },
		{ id: 'product', label: 'Продуктовые компоненты' },
		{ id: 'shell', label: 'Оболочка' }
	];
</script>

<svelte:head>
	<title>Дизайн-система — ФСП | Карьера</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-7xl space-y-10 px-4 py-10 sm:px-6">
	<header class="space-y-3">
		<p class="font-mono text-label text-link uppercase">Витрина</p>
		<h1 class="text-h1">Дизайн-система</h1>
		<p class="max-w-3xl text-muted-foreground">
			Токены, базовые и продуктовые компоненты во всех состояниях, в светлой и тёмной теме (переключатель в шапке).
		</p>
		<nav aria-label="Разделы витрины">
			<ul class="flex flex-wrap gap-2">
				{#each contents as item (item.id)}
					<li>
						<a href="#{item.id}" class="inline-flex rounded-full border bg-card px-3 py-1 text-sm hover:bg-muted">
							{item.label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	</header>
	<TokensSection />
	<BaseSection />
	<ProductSection />
	<ShellSection />
</div>
