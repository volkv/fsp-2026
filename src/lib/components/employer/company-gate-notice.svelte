<script lang="ts">
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { resolve } from '$app/paths';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import type { CompanyStatus } from './model.js';

	/**
	 * Why the catalog, publication and invitations are closed right now (domain 4.2, 5.1): only a company verified by
	 * an FSP operator acts towards candidates. Vacancies can be prepared meanwhile.
	 */
	let { status, role }: { status: Exclude<CompanyStatus, 'verified'>; role: 'owner' | 'recruiter' } = $props();

	const texts: Record<Exclude<CompanyStatus, 'verified'>, { title: string; text: string }> = {
		draft: {
			title: 'Компания ещё не подана на проверку',
			text: 'Каталог кандидатов, публикация вакансий и приглашения откроются после проверки оператором ФСП. Черновики вакансий можно готовить уже сейчас.'
		},
		submitted: {
			title: 'Компания на проверке у оператора ФСП',
			text: 'Оператор сверяет ИНН и полномочия заявителя. До решения каталог кандидатов закрыт, публиковать и приглашать нельзя; черновики вакансий готовить можно.'
		},
		rejected: {
			title: 'Проверка компании отклонена',
			text: 'Каталог, публикация и приглашения закрыты. Причина — в профиле компании; исправьте реквизиты и подайте заявку снова.'
		},
		suspended: {
			title: 'Компания приостановлена оператором ФСП',
			text: 'Каталог, приглашения и ключи API закрыты. Уже начатые процессы найма остаются открытыми.'
		}
	};
	const content = $derived(texts[status]);
</script>

<Alert.Root role="status" class="border-warning/40 bg-warning-subtle" data-testid="company-gate">
	<ShieldAlertIcon aria-hidden="true" class="text-warning" />
	<Alert.Title>{content.title}</Alert.Title>
	<Alert.Description>
		<p>{content.text}</p>
		{#if role === 'owner' && status !== 'suspended'}
			<a class="text-link underline underline-offset-4" href={resolve('/company/profile')}
				>Профиль и проверка компании</a
			>
		{/if}
	</Alert.Description>
</Alert.Root>
