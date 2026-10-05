<script lang="ts">
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const ANNUL_REASONS = {
		decision_annulled: 'решение теста аннулировано (например, из-за нарушения или сбоя попытки)',
		objection_annulled: 'попытка аннулирована по возражению',
		objection_rescored: 'решение пересчитано по возражению'
	} as const;

	const dateFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
	const day = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));
	const holder = $derived(form?.holder ?? null);
</script>

<svelte:head>
	<title>Проверка категории — ФСП | Карьера</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-10">
	<header class="grid gap-2">
		<h1 class="text-2xl font-semibold tracking-tight">Проверка категории</h1>
		<p class="text-muted-foreground">
			Подписанное платформой заявление о категории кандидата: специализация и грейд, подтверждённые тестом. Оно не
			раскрывает, о ком оно: имя и контакты здесь не показываются.
		</p>
	</header>

	{#if data.signature === 'valid'}
		<Alert.Root data-testid="attestation-signature" data-signature="valid">
			<ShieldCheckIcon aria-hidden="true" />
			<Alert.Title>Подпись действительна</Alert.Title>
			<Alert.Description>
				Заявление подписано ключом {data.signingKeyId} платформы {data.statement.issuer} и с тех пор не изменялось.
			</Alert.Description>
		</Alert.Root>
	{:else}
		<Alert.Root variant="destructive" data-testid="attestation-signature" data-signature={data.signature}>
			<ShieldAlertIcon aria-hidden="true" />
			<Alert.Title>Подпись не подтверждается</Alert.Title>
			<Alert.Description>
				{data.signature === 'unknown_key'
					? `Ключ ${data.signingKeyId} не опубликован платформой.`
					: 'Подпись не сходится с заявлением: доверять ему нельзя.'}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<section
		class="grid gap-3 rounded-xl border p-5"
		data-testid="attestation-status"
		data-status={data.status}
		aria-labelledby="attestation-title"
	>
		<h2 id="attestation-title" class="text-xl font-semibold">{data.title.specialization} · {data.title.grade}</h2>
		{#if data.status === 'valid'}
			<p class="flex items-start gap-2 text-sm">
				<BadgeCheckIcon class="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
				<span
					><span class="font-medium">Категория действует.</span> Подтверждена тестом платформы {day(
						data.statement.decidedOn
					)}.</span
				>
			</p>
		{:else if data.status === 'superseded'}
			<p class="text-sm">
				<span class="font-medium">Это прошлый результат, а не действующая категория.</span>
				Было действительно{data.endedOn ? ` до ${day(data.endedOn)}` : ''}{data.current
					? `, сейчас подтверждён грейд ${data.current.grade} (с ${day(data.current.assignedOn)})`
					: ''}.
			</p>
		{:else}
			<p class="text-sm text-destructive">
				<span class="font-medium">Подтверждение аннулировано</span>{data.endedOn
					? ` ${day(data.endedOn)}`
					: ''}{data.annulReason ? `: ${ANNUL_REASONS[data.annulReason]}` : ''}. Категорию этот результат больше не
				подтверждает.
			</p>
		{/if}
		<dl class="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
			<dt class="text-muted-foreground">Определяющие блоки</dt>
			<dd>{data.statement.blocks.join(', ') || '—'}</dd>
			<dt class="text-muted-foreground">Подтверждённый стек</dt>
			<dd>{data.statement.skills.join(', ') || '—'}</dd>
			<dt class="text-muted-foreground">Основание</dt>
			<dd>
				справочник категорий {data.statement.catalogVersion}, выпуск банка заданий {data.statement.bankReleaseId},
				решение
				{day(data.statement.decidedOn)}
			</dd>
			{#if data.statement.judgementNote}
				<dt class="text-muted-foreground">Проверка заданий</dt>
				<dd data-testid="attestation-judgement">{data.statement.judgementNote}</dd>
			{/if}
			<dt class="text-muted-foreground">Не проверяется</dt>
			<dd>
				<ul class="grid list-disc gap-1 pl-4">
					{#each data.statement.doesNotAssert as limit (limit)}
						<li>{limit}</li>
					{/each}
				</ul>
			</dd>
		</dl>
	</section>

	<section class="grid gap-3 rounded-xl border p-5" aria-labelledby="holder-title" data-testid="attestation-holder">
		<h2 id="holder-title" class="text-lg font-semibold">Принадлежит ли подтверждение предъявителю</h2>
		<p class="text-sm text-muted-foreground">
			Кандидат видит код владельца в своём кабинете и передаёт его по своей воле. Введите ФИО в порядке «Фамилия Имя
			Отчество» и код — платформа сверит их с обязательством в заявлении. ФИО и код не сохраняются.
		</p>
		{#if holder && 'problem' in holder}
			<FormMessage text={holder.problem} />
		{:else if holder && 'matches' in holder}
			<FormMessage
				tone={holder.matches ? 'success' : 'error'}
				text={holder.matches
					? 'Совпадает: подтверждение выдано человеку с этим ФИО.'
					: 'Не совпадает: ФИО или код владельца другие.'}
			/>
		{/if}
		<form method="POST" action="?/holder" use:enhance class="grid gap-3 sm:grid-cols-2">
			<CsrfInput />
			<div class="grid gap-1.5">
				<Label for="holder-name">ФИО</Label>
				<Input id="holder-name" name="full_name" autocomplete="off" required maxlength={300} />
			</div>
			<div class="grid gap-1.5">
				<Label for="holder-code">Код владельца</Label>
				<Input id="holder-code" name="code" autocomplete="off" required maxlength={64} value={data.holderCode} />
			</div>
			<Button type="submit" class="justify-self-start">Проверить</Button>
		</form>
	</section>

	<details class="rounded-lg border p-4 text-sm">
		<summary class="cursor-pointer font-medium">Как проверить самостоятельно</summary>
		<div class="mt-3 grid gap-2 text-muted-foreground">
			<p>
				Подпись Ed25519 поставлена над каноническим JSON заявления (ключи отсортированы на всех уровнях). Заявление и
				подпись отдаёт /api/v1/verify/categories/{data.handle}, открытые ключи — /.well-known/receipt-keys.json.
			</p>
			<p class="font-mono break-all text-foreground">Обязательство владельца: {data.statement.holderCommitment}</p>
		</div>
	</details>
</div>
