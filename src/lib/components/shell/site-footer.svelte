<script lang="ts">
	import BrandStrip from '$lib/components/brand/brand-strip.svelte';
	import FspLogo from '$lib/components/brand/fsp-logo.svelte';
</script>

<footer class="border-t bg-card">
	<div class="mx-auto max-w-7xl px-4 pt-8 sm:px-6">
		<BrandStrip class="h-4" />
	</div>
	<div
		class="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6"
	>
		<p class="flex items-center gap-3">
			<FspLogo class="h-6" title="ФСП" />
			<span>Карьера — платформа ИТ-найма, где навыки подтверждены</span>
		</p>
		<p>Прототип для Федерации спортивного программирования России</p>
	</div>
</footer>
