<script lang="ts">
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { resolve } from '$app/paths';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import type { CompanyStatus } from './model.js';

	/**
	 * The state of the company under the admission policy (domain 5.1): a company without a check acts towards
	 * candidates — the catalog, vacancies and offers are open, and candidates see the label «не проверена»; a suspended
	 * or rejected company is closed.
	 */
	let { status, role }: { status: Exclude<CompanyStatus, 'verified'>; role: 'owner' | 'recruiter' } = $props();

	const texts: Record<Exclude<CompanyStatus, 'verified'>, { title: string; text: string }> = {
		draft: {
			title: 'Компания не проверена',
			text: 'Каталог кандидатов, вакансии и предложения открыты. Кандидаты видят в предложениях метку «компания не проверена»; проверка оператором ФСП её снимает и необязательна.'
		},
		submitted: {
			title: 'Компания на проверке у оператора ФСП',
			text: 'Работать с кандидатами можно уже сейчас; до решения оператора кандидаты видят метку «компания не проверена».'
		},
		rejected: {
			title: 'Проверка компании отклонена',
			text: 'Каталог, вакансии и предложения закрыты, пока владелец не исправит данные и не подаст заявку снова. Причина — в профиле компании.'
		},
		suspended: {
			title: 'Компания приостановлена оператором ФСП',
			text: 'Каталог, предложения и ключи API закрыты. Уже начатые процессы найма остаются открытыми.'
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
