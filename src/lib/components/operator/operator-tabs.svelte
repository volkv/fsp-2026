<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import { viewerFrom } from '$lib/components/shell/viewer.js';
	import { cn } from '$lib/components/utils.js';
	import { permittedItems, type NavPermission } from '$lib/navigation.js';

	interface Tab {
		href: ResolvedPathname;
		label: string;
		exact: boolean;
		/** Shown only to an operator holding this permission. */
		permission?: NavPermission;
	}

	/**
	 * Sections of the operator cabinet: the queues first, then partnerships and the analytics of the federation, and the
	 * journal for an operator the administrator granted it.
	 */
	const allTabs: Tab[] = [
		{ href: resolve('/operator'), label: 'Обзор', exact: true },
		{ href: resolve('/operator/companies'), label: 'Компании', exact: false },
		{ href: resolve('/operator/objections'), label: 'Возражения', exact: false },
		{ href: resolve('/operator/complaints'), label: 'Жалобы на предложения', exact: false },
		{ href: resolve('/operator/representatives'), label: 'Представители', exact: false },
		{ href: resolve('/operator/ages'), label: 'Конфликты возраста', exact: false },
		{ href: resolve('/operator/vacancies'), label: 'Модерация вакансий', exact: false },
		{ href: resolve('/operator/claims'), label: '«Это наша вакансия»', exact: false },
		{ href: resolve('/operator/assessments'), label: 'Попытки тестов', exact: false },
		{ href: resolve('/operator/partnerships'), label: 'Партнёрства', exact: false },
		{ href: resolve('/operator/outcomes'), label: 'Карьерные исходы', exact: false },
		{ href: resolve('/operator/skills'), label: 'Навыки рынка ↔ ФСП', exact: false },
		{ href: resolve('/operator/fsp-import'), label: 'Импорт результатов', exact: false },
		{ href: resolve('/operator/audit'), label: 'Журнал', exact: false, permission: 'audit.read' }
	];

	const tabs = $derived(permittedItems(allTabs, viewerFrom(page.data)?.permissions ?? []));

	const isCurrent = (tab: Tab) => (tab.exact ? page.url.pathname === tab.href : page.url.pathname.startsWith(tab.href));
</script>

<nav aria-label="Разделы кабинета оператора">
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
