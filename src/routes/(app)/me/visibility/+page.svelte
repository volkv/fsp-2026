<script lang="ts">
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { CATALOG_SCOPE, DISCLOSURE_FIELDS, HIDDEN_REASONS } from '$lib/components/candidate/model.js';
	import PartnerPoolConsent from '$lib/components/candidate/partner-pool-consent.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const overview = $derived(data.overview);
	const text = $derived(overview.texts.catalog);
	const adult = $derived(overview.ageRegime === 'adult');
	const canGrant = $derived(adult || (overview.ageRegime === 'minor' && overview.representativeVerified));
	const scopes = Object.keys(CATALOG_SCOPE) as (keyof typeof CATALOG_SCOPE)[];
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldLabel = (field: string) =>
		field === 'full_name' || field === 'email' || field === 'phone' || field === 'resume'
			? DISCLOSURE_FIELDS[field]
			: field;
</script>

<PageHeader
	title="Видимость и согласия"
	description="Приватность по умолчанию: профиль видят только проверенные компании и только по твоему согласию. Каждое согласие — отдельно, и его можно отозвать."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'catalogSaved' in form}
	<FormMessage tone="success" text="Сохранено: состав карточки в каталоге обновлён." />
{:else if form && 'catalogRevoked' in form}
	<FormMessage tone="success" text="Показ в каталоге выключен. Ты исчез из поиска работодателей." />
{:else if form && 'poolGranted' in form}
	<FormMessage tone="success" text="Согласие дано: партнёры соревнования видят твою карточку в своём пуле." />
{:else if form && 'poolRevoked' in form}
	<FormMessage tone="success" text="Карточка убрана из пула партнёров этого соревнования." />
{:else if form && 'disclosureRevoked' in form}
	<FormMessage tone="success" text="Согласие на раскрытие контактов отозвано." />
{/if}

<div
	class="flex items-start gap-3 rounded-xl border p-4 {overview.hiddenReason === null
		? 'bg-success-subtle'
		: 'bg-muted'}"
	data-testid="visibility-state"
	data-visible={overview.hiddenReason === null}
>
	{#if overview.hiddenReason === null}
		<EyeIcon class="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
		<p class="text-sm">
			<span class="font-medium">Проверенные работодатели находят тебя в каталоге.</span>
			Они видят псевдоним, категорию, навыки с квитанциями и обобщённые достижения — без имени и контактов.
		</p>
	{:else}
		<EyeOffIcon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
		<p class="text-sm">
			<span class="font-medium">Сейчас работодатели тебя не видят.</span>
			{HIDDEN_REASONS[overview.hiddenReason]}
		</p>
	{/if}
</div>

<SectionCard
	title="Показ в каталоге"
	description="Согласие на показ профиля работодателям платформы, кроме заблокированных; у непроверенной компании в предложении стоит метка «компания не проверена». Без него профиль закрыт; категория, приглашения и история остаются."
	testId="catalog-consent"
>
	{#if overview.ageRegime === 'unknown'}
		<p class="text-sm text-muted-foreground">
			Возраст не подтверждён: показ в каталоге недоступен до решения оператора.
		</p>
	{:else if !canGrant}
		<p class="text-sm" data-testid="minor-regime">
			Тебе меньше 18: профиль закрыт, пока оператор ФСП не подтвердит полномочия законного представителя. После этого
			работодатель увидит тебя только в контексте подходящей стажировки, не во всём каталоге.
		</p>
	{:else}
		{#if overview.catalog.subjectGranted}
			<p class="text-sm">
				Твоё согласие дано{overview.catalog.grantedAt ? ` ${formatDate(overview.catalog.grantedAt)}` : ''}.
				{#if !overview.catalog.effective}
					<span class="text-muted-foreground">Оно вступит в силу вместе с согласием представителя.</span>
				{/if}
			</p>
		{/if}
		{#if text}
			<form method="POST" action="?/catalogGrant" use:enhance class="grid gap-4">
				<CsrfInput />
				<input type="hidden" name="documentId" value={text.id} />
				{#if adult}
					<fieldset class="grid gap-3">
						<legend class="mb-1 text-sm font-medium">Что добавить к обобщённой карточке</legend>
						{#each scopes as scope (scope)}
							<label class="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									name="scope_fields"
									value={scope}
									class="mt-0.5 size-4 accent-primary"
									checked={overview.catalog.scopeFields.includes(scope)}
								/>
								<span class="grid gap-0.5">
									<span class="font-medium">{CATALOG_SCOPE[scope].label}</span>
									<span class="text-xs text-muted-foreground">{CATALOG_SCOPE[scope].hint}</span>
								</span>
							</label>
						{/each}
					</fieldset>
				{:else}
					<p class="text-sm text-muted-foreground">
						До 18 лет каталог показывает достижения только на уровне «дисциплина и уровень соревнования»; точные
						сведения и профили до контакта недоступны.
					</p>
				{/if}
				<details class="rounded-lg border text-sm" open={!overview.catalog.subjectGranted}>
					<summary class="cursor-pointer px-3 py-2 font-medium">{text.title} · редакция {text.version}</summary>
					<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="max-h-64 overflow-y-auto px-3 pb-3 whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
						data-testid="catalog-consent-text"
						role="region"
						aria-label="Текст согласия"
						tabindex="0"
					>
						{text.body}
					</div>
				</details>
				<Button type="submit" class="justify-self-start">
					{overview.catalog.subjectGranted ? 'Сохранить состав карточки' : 'Даю согласие и показываю профиль'}
				</Button>
			</form>
		{:else}
			<p class="text-sm text-muted-foreground">Текст согласия на показ в каталоге не опубликован.</p>
		{/if}

		{#if overview.catalog.subjectGranted}
			<form method="POST" action="?/catalogRevoke" use:enhance class="grid gap-2 rounded-lg border border-dashed p-4">
				<CsrfInput />
				<p class="text-sm">
					<span class="font-medium">Отозвать согласие.</span> Ты сразу пропадёшь из поиска и счётчиков. Уже раскрытые контакты
					останутся у компаний, которым ты их передал; открытые приглашения останутся у тебя.
				</p>
				<Button type="submit" variant="outline" size="sm" class="justify-self-start">Выключить показ в каталоге</Button>
			</form>
		{/if}
	{/if}
</SectionCard>

<SectionCard
	title="Пул партнёров соревнований"
	description="Партнёр соревнования (кейсодатель, спонсор) видит финалистов, которые на это согласились. Согласие — отдельное для каждого соревнования и не зависит от показа в каталоге."
	testId="partner-pool-consent"
>
	<PartnerPoolConsent adult={data.partnerPool.adult} offers={data.partnerPool.offers} text={data.partnerPool.text} />
</SectionCard>

<SectionCard
	title="Раскрытие контактов"
	description="Контакты получает только компания принятого приглашения и только выбранные поля. Отзыв закрывает ей доступ сразу; уже переданное остаётся у неё."
	testId="disclosures"
>
	{#if overview.disclosures.length === 0}
		<p class="text-sm text-muted-foreground">Ты никому не раскрывал контакты.</p>
	{:else}
		<ul class="grid gap-3">
			{#each overview.disclosures as item (item.invitationId)}
				<li class="grid gap-2 rounded-lg border p-3 text-sm">
					<a
						class="font-medium text-link underline underline-offset-4"
						href={resolve('/(app)/me/invitations/[id]', { id: item.invitationId })}
						>{item.companyName} · {item.vacancyTitle}</a
					>
					<p>
						{#if item.fields.length > 0}
							Согласие действует: {item.fields.map(fieldLabel).join(', ')}.
						{:else}
							Согласие отозвано.
						{/if}
					</p>
					{#if item.disclosed.length > 0}
						<ul class="grid gap-0.5 text-xs text-muted-foreground" aria-label="Журнал раскрытий">
							{#each item.disclosed as entry, index (index)}
								<li>Передано {formatDateTime(entry.at)}: {entry.fields.map(fieldLabel).join(', ')}</li>
							{/each}
						</ul>
					{/if}
					{#if item.fields.length > 0}
						<form method="POST" action="?/disclosureRevoke" use:enhance>
							<CsrfInput />
							<input type="hidden" name="invitationId" value={item.invitationId} />
							<Button type="submit" variant="outline" size="sm">Отозвать согласие на раскрытие</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>

<SectionCard title="Уведомления" description="Каналы и Telegram настраиваются отдельно.">
	<a class="text-sm text-link underline underline-offset-4" href={resolve('/account/notifications')}
		>Настройки уведомлений</a
	>
</SectionCard>
