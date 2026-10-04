<script lang="ts">
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { assertion } from '$lib/components/candidate/model.js';
	import { VerificationReceipt } from '$lib/components/product/index.js';
	import { RECEIPT_SOURCES, type ReceiptSource, type ReceiptView } from '$lib/components/product/model.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const STATUS_MEANING = {
		valid: 'Факт действует в той версии, о которой выдана квитанция.',
		superseded: 'Источник прислал новую версию записи: квитанция описывает прежнюю.',
		annulled: 'Источник аннулировал результат: квитанция его больше не подтверждает.',
		not_valid: 'Основание квитанции изъято: кандидат отозвал согласие, отвязал источник или удалил данные.'
	} as const;

	const isSource = (value: string): value is ReceiptSource => value in RECEIPT_SOURCES;

	const receipt = $derived.by((): ReceiptView | null => {
		const { statement } = data;
		if (!isSource(statement.source)) return null;
		const asserts = Object.entries(statement.asserts).map(([key, value]) => assertion(key, value));
		const discipline = statement.asserts.discipline;
		const season = statement.asserts.season;
		const title = [
			discipline === undefined ? null : assertion('discipline', discipline).value,
			season === undefined ? null : String(season)
		]
			.filter((part) => part !== null)
			.join(', ');
		return {
			handle: data.handle,
			source: statement.source,
			title: title || RECEIPT_SOURCES[statement.source],
			verifiedAt: statement.verifiedAt,
			status: data.status,
			disclosure: data.level,
			asserts,
			doesNotAssert: statement.doesNotAssert,
			signingKeyId: data.signingKeyId
		};
	});
</script>

<svelte:head>
	<title>Проверка квитанции — ФСП | Карьера</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-10">
	<header class="grid gap-2">
		<h1 class="text-2xl font-semibold tracking-tight">Проверка квитанции</h1>
		<p class="text-muted-foreground">
			Квитанция — подписанное платформой заявление о проверенном факте. Она говорит, что подтверждено, каким источником
			и когда, и не раскрывает, о ком она.
		</p>
	</header>

	{#if data.signature === 'valid'}
		<Alert.Root data-testid="receipt-signature" data-signature="valid">
			<ShieldCheckIcon aria-hidden="true" />
			<Alert.Title>Подпись действительна</Alert.Title>
			<Alert.Description>
				Заявление подписано ключом {data.signingKeyId} платформы {data.statement.issuer} и с тех пор не изменялось. Открытые
				ключи опубликованы по адресу /.well-known/receipt-keys.json.
			</Alert.Description>
		</Alert.Root>
	{:else}
		<Alert.Root variant="destructive" data-testid="receipt-signature" data-signature={data.signature}>
			<ShieldAlertIcon aria-hidden="true" />
			<Alert.Title>Подпись не подтверждается</Alert.Title>
			<Alert.Description>
				{data.signature === 'unknown_key'
					? `Ключ ${data.signingKeyId} не опубликован платформой.`
					: 'Подпись не сходится с заявлением: доверять квитанции нельзя.'}
			</Alert.Description>
		</Alert.Root>
	{/if}

	{#if data.statement.simulator}
		<Alert.Root data-testid="receipt-simulator-notice">
			<FlaskConicalIcon aria-hidden="true" />
			<Alert.Title>Источник — имитатор ФСП</Alert.Title>
			<Alert.Description>
				Квитанция выдана демонстрационным стендом: факт получен от имитатора ФСП ID и API достижений, а не от Федерации
				спортивного программирования. Спортсмен и результаты синтетические; подпись подтверждает только то, что стенд
				выдал это заявление.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<p class="text-sm" data-testid="receipt-status-meaning">{STATUS_MEANING[data.status]}</p>

	{#if receipt}
		<VerificationReceipt {receipt} simulator={data.statement.simulator} />
	{/if}

	<details class="rounded-lg border p-4 text-sm">
		<summary class="cursor-pointer font-medium">Как проверить самостоятельно</summary>
		<div class="mt-3 grid gap-2 text-muted-foreground">
			<p>
				Подпись Ed25519 поставлена над каноническим JSON заявления (ключи отсортированы на всех уровнях). Заявление и
				подпись отдаёт /api/v1/verify/{data.handle}, открытый ключ — /.well-known/receipt-keys.json по идентификатору
				ключа.
			</p>
			<p>
				Ссылка на запись источника в обобщённой квитанции заменена обязательством с солью: квитанции одного человека,
				выданные разным компаниям, между собой не связываются.
			</p>
			<p class="font-mono break-all text-foreground">Обязательство: {data.statement.recordCommitment}</p>
		</div>
	</details>
</div>
