<script lang="ts">
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6 sm:py-10" data-testid="account-deleted">
	<PageHeader
		title="Учётная запись удалена"
		description="Вход закрыт, данные стираются в течение 30 дней. Контакты, уже переданные компаниям, остаются у них."
	/>
	<p class="text-sm">
		{data.letterSent
			? 'Подтверждение отправлено на почту учётной записи.'
			: 'Письмо с подтверждением отправить не удалось — удаление от этого не зависит.'}
	</p>
	<a class="text-sm text-link underline underline-offset-4" href={resolve('/')}>На главную</a>
</div>
