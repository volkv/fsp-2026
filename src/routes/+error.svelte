<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import ShieldXIcon from '@lucide/svelte/icons/shield-x';
	import TimerIcon from '@lucide/svelte/icons/timer';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';

	/**
	 * What the status means to the person and what to do next. The message of the error is shown under it: the server
	 * words it for people (`handleError` replaces the message of an unexpected failure).
	 */
	const explanation = $derived.by(() => {
		const { status } = page;
		if (status === 429) {
			return {
				icon: TimerIcon,
				title: 'Слишком много запросов',
				hint: 'С вашего адреса пришло больше запросов, чем допускает лимит. Подождите минуту и обновите страницу.'
			};
		}
		if (status === 404) {
			return { icon: SearchXIcon, title: 'Страница не найдена', hint: 'Проверьте адрес или начните с главной.' };
		}
		if (status === 401 || status === 403) {
			return {
				icon: ShieldXIcon,
				title: 'Нет доступа',
				hint: 'Эта страница открыта не всем: войдите под нужной учётной записью.'
			};
		}
		return {
			icon: CircleAlertIcon,
			title: status >= 500 ? 'Сбой на сервере' : 'Запрос не выполнен',
			hint: 'Попробуйте ещё раз немного позже.'
		};
	});
</script>

<svelte:head>
	<title>{explanation.title} — ФСП | Карьера</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto grid w-full max-w-2xl px-4 py-16">
	<Empty.Root data-testid="error-page" data-status={page.status}>
		<Empty.Header>
			<Empty.Media variant="icon">
				<explanation.icon aria-hidden="true" />
			</Empty.Media>
			<Empty.Title>
				<h1 class="text-xl font-semibold tracking-tight">{explanation.title}</h1>
			</Empty.Title>
			<Empty.Description>
				<p>{explanation.hint}</p>
				{#if page.error && page.error.message !== explanation.title}
					<p class="mt-2">{page.error.message}</p>
				{/if}
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a href={resolve('/')} class={buttonVariants({ variant: 'outline' })}>На главную</a>
			{#if page.error?.requestId}
				<p class="text-xs text-muted-foreground">
					Код ошибки {page.status}, номер запроса
					<span class="font-mono" data-testid="error-request-id">{page.error.requestId}</span>
				</p>
			{/if}
		</Empty.Content>
	</Empty.Root>
</div>
