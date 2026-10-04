<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { cn } from '$lib/components/utils.js';

	/** Sections of the company: the profile for every member; the team and the API keys for its owner. */
	let { role }: { role: 'owner' | 'recruiter' } = $props();

	const tabs = $derived([
		{ href: resolve('/company/profile'), label: 'Профиль и проверка' },
		...(role === 'owner'
			? [
					{ href: resolve('/company/profile/team'), label: 'Команда' },
					{ href: resolve('/company/profile/keys'), label: 'Ключи API' }
				]
			: [])
	]);
</script>

<nav aria-label="Разделы компании">
	<ul class="flex flex-wrap gap-1 border-b">
		{#each tabs as tab (tab.href)}
			{@const active = page.url.pathname === tab.href}
			<li>
				<a
					href={tab.href}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'-mb-px inline-flex border-b-2 px-3 py-2 text-sm font-medium transition-colors',
						active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
					)}
				>
					{tab.label}
				</a>
			</li>
		{/each}
	</ul>
</nav>
