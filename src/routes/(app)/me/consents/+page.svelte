<script lang="ts">
	import MailIcon from '@lucide/svelte/icons/mail';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { REPRESENTATION_STATES, REPRESENTATIVE_CONSENTS } from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const representative = $derived(data.representative);
	const representation = $derived(representative?.representation ?? null);
	const verified = $derived(representation?.status === 'authority_verified');
	const message = $derived(
		form && 'problem' in form ? (form.problem?.message ?? null) : form && 'message' in form ? form.message : null
	);
	const fsp = $derived(data.fsp);
</script>

<PageHeader
	title="Согласия"
	description="Основание, на котором ведётся твой профиль, и кто его подписал. До 18 лет каждое согласие действует, когда его дали и ты, и законный представитель."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
	{#snippet actions()}
		<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/visibility')}>Видимость профиля</a>
	{/snippet}
</PageHeader>

{#if message}
	<FormMessage text={message} />
{:else if form && 'renewed' in form}
	<FormMessage tone="success" text="Согласие подписано: профиль снова обрабатывается." />
{:else if form && 'resent' in form}
	<FormMessage tone="success" text="Письмо представителю отправлено." />
{:else if form && 'fspRevoked' in form}
	<FormMessage
		tone="success"
		text="Согласие на получение достижений ФСП отозвано: импорт прекращён, достижения выведены из профиля и будут удалены."
	/>
{/if}

<SectionCard
	title="Обработка персональных данных"
	description="Без этого согласия профиль не ведётся: резюме не разбирается, категория не считается, работодатели тебя не видят."
	testId="processing-consent"
>
	<p
		class="flex flex-wrap items-center gap-2 text-sm"
		data-testid="processing-state"
		data-effective={data.processing.effective}
	>
		{#if data.processing.effective}
			<StatusPill label="Действует" tone="success" />
		{:else if data.processing.ownSigned && data.regime === 'minor'}
			<StatusPill label="Ждёт подписи представителя" tone="warning" />
		{:else}
			<StatusPill label="Нужна твоя подпись" tone="warning" />
		{/if}
	</p>
	{#if data.processing.document}
		{#if data.regime === 'adult'}
			<p class="text-sm">
				Тебе исполнилось 18: согласия, подписанные до совершеннолетия, больше не действуют. Подтверди согласие сам —
				после этого профиль снова обрабатывается, а показ работодателям включается на странице видимости.
			</p>
		{:else}
			<p class="text-sm">Текст согласия обновился: прочитай новую редакцию и подпиши её.</p>
		{/if}
		<details class="rounded-lg border text-sm" open>
			<summary class="cursor-pointer px-3 py-2 font-medium">
				{data.processing.document.title} · редакция {data.processing.document.version}
			</summary>
			<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="max-h-64 overflow-y-auto px-3 pb-3 whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				data-testid="consent-text"
				role="region"
				aria-label="Текст согласия"
				tabindex="0"
			>
				{data.processing.document.body}
			</div>
		</details>
		<form method="POST" action="?/renew" use:enhance>
			<CsrfInput />
			<input type="hidden" name="documentId" value={data.processing.document.id} />
			<Button type="submit">Даю согласие</Button>
		</form>
	{/if}
	<p class="text-sm text-muted-foreground">
		Отозвать согласие можно в любой момент. Без него профиль не ведётся, поэтому отзыв удаляет профиль и учётную запись:
		<a
			class="text-link underline underline-offset-4"
			href="{resolve('/account/delete')}?cause=processing_revoked"
			data-testid="revoke-processing">отозвать согласие и удалить профиль</a
		>.
	</p>
</SectionCard>

<SectionCard
	title="Достижения из систем ФСП"
	description="Пока действует это согласие, результаты соревнований ФСП попадают в профиль и обновляются. После отзыва импорт прекращается, достижения сразу выводятся из профиля, их квитанции проверки отвечают «отозвано», а сами записи удаляются."
	testId="fsp-consent"
>
	<p class="flex flex-wrap items-center gap-2 text-sm" data-testid="fsp-state" data-effective={fsp.effective}>
		{#if fsp.effective}
			<StatusPill label="Действует" tone="success" />
		{:else if fsp.subjectGranted && data.regime === 'minor'}
			<StatusPill label="Ждёт подписи представителя" tone="warning" />
		{:else if fsp.revokedAt}
			<StatusPill label="Отозвано" tone="neutral" />
		{:else}
			<StatusPill label="Не дано" tone="neutral" />
		{/if}
		{#if fsp.grantedAt}
			<span class="text-muted-foreground">дано {formatDateTime(fsp.grantedAt)}</span>
		{:else if fsp.revokedAt}
			<span class="text-muted-foreground">отозвано {formatDateTime(fsp.revokedAt)}</span>
		{/if}
	</p>
	{#if fsp.subjectGranted}
		<p class="text-sm">Достижений ФСП в профиле: {fsp.facts}.</p>
		<form method="POST" action="?/revokeFsp" use:enhance class="grid gap-3 sm:max-w-md">
			<CsrfInput />
			<div class="grid gap-1 text-sm">
				<label for="fsp-revoke-reason">Причина (необязательно)</label>
				<Input id="fsp-revoke-reason" name="reason" maxlength={500} autocomplete="off" />
			</div>
			<Button type="submit" variant="destructive" class="justify-self-start">Отозвать согласие</Button>
		</form>
	{:else}
		<p class="text-sm text-muted-foreground">
			Дать согласие можно на странице <a class="text-link underline underline-offset-4" href={resolve('/account')}
				>учётной записи</a
			>: после входа через ФСП ID — «Подтвердить достижения из ФСП».
		</p>
	{/if}
</SectionCard>

{#if data.regime === 'minor'}
	<SectionCard
		title="Законный представитель"
		description="У представителя нет кабинета: согласия он подписывает по одноразовой ссылке из письма, после того как оператор ФСП проверил его полномочия."
		testId="representative"
	>
		{#if representation === null}
			<p class="text-sm">Представитель не указан — без него профиль до 18 лет закрыт.</p>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/onboarding/representative')}
				>Указать законного представителя</a
			>
		{:else}
			{@const state = REPRESENTATION_STATES[representation.status]}
			<p class="flex flex-wrap items-center gap-2 text-sm">
				<StatusPill label={state.label} tone={state.tone} />
				<span class="text-muted-foreground">{state.hint}</span>
			</p>
		{/if}
		{#if representative && verified}
			<ul class="grid gap-2" data-testid="representative-consents">
				{#each representative.consents as consent (consent.kind)}
					<li
						class="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
						data-consent={consent.kind}
						data-representative={consent.representative}
					>
						<span class="grid gap-0.5">
							<span class="font-medium">{REPRESENTATIVE_CONSENTS[consent.kind].label}</span>
							<span class="text-xs text-muted-foreground">{REPRESENTATIVE_CONSENTS[consent.kind].hint}</span>
						</span>
						<span class="flex flex-wrap gap-2">
							<StatusPill
								label={consent.candidate ? 'Ты: дано' : 'Ты: не дано'}
								tone={consent.candidate ? 'success' : 'neutral'}
							/>
							<StatusPill
								label={consent.representative ? 'Представитель: получено' : 'Представитель: ожидается'}
								tone={consent.representative ? 'success' : 'warning'}
							/>
						</span>
					</li>
				{/each}
			</ul>
			<div class="flex flex-wrap items-center gap-3">
				<form method="POST" action="?/resend" use:enhance>
					<CsrfInput />
					<Button type="submit" variant="outline" size="sm">
						<MailIcon aria-hidden="true" />
						Отправить письмо представителю ещё раз
					</Button>
				</form>
				{#if representative.letter}
					<span class="text-xs text-muted-foreground">
						Последнее письмо — {formatDateTime(representative.letter.sentAt)}. Новое письмо отменяет ссылку предыдущего.
					</span>
				{/if}
			</div>
		{/if}
	</SectionCard>

	{#if data.waiting.length > 0}
		<SectionCard
			title="Ждут согласия представителя"
			description="Ты принял эти приглашения; контакты компания получит, когда согласится представитель. Ответить он должен до срока ответа на приглашение."
			testId="waiting-invitations"
		>
			<ul class="grid gap-2 text-sm">
				{#each data.waiting as item (item.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
						<a
							class="text-link underline underline-offset-4"
							href={resolve('/(app)/me/invitations/[id]', { id: item.id })}>{item.vacancyTitle} · {item.companyName}</a
						>
						<span class="text-muted-foreground">до {formatDateTime(item.responseDueAt)}</span>
					</li>
				{/each}
			</ul>
		</SectionCard>
	{/if}
{/if}
