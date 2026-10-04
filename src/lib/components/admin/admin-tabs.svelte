<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { cn } from '$lib/components/utils.js';

	/** Sections of the administrator cabinet: operations first, then the reference books, people and the journal. */
	const tabs = [
		{ href: resolve('/admin'), label: 'Обзор и модели', exact: true },
		{ href: resolve('/admin/sources'), label: 'Источники вакансий', exact: false },
		{ href: resolve('/admin/quality'), label: 'Качество моделей', exact: false },
		{ href: resolve('/admin/taxonomy'), label: 'Таксономия', exact: false },
		{ href: resolve('/admin/rules'), label: 'Правила', exact: false },
		{ href: resolve('/admin/documents'), label: 'Документы', exact: false },
		{ href: resolve('/admin/policies'), label: 'Политики', exact: false },
		{ href: resolve('/admin/staff'), label: 'Пользователи и персонал', exact: false },
		{ href: resolve('/admin/audit'), label: 'Журнал действий', exact: false }
	];

	const isCurrent = (tab: (typeof tabs)[number]) =>
		tab.exact ? page.url.pathname === tab.href : page.url.pathname.startsWith(tab.href);
</script>

<nav aria-label="Разделы кабинета администратора">
	<ul class="flex flex-wrap gap-1 border-b">
		{#each tabs as tab (tab.href)}
			{@const active = isCurrent(tab)}
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
