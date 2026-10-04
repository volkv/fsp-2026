<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CompanyTabs from '$lib/components/employer/company-tabs.svelte';
	import { AUTHORITY_METHODS, COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const overview = $derived(data.overview);
	const minorTerms = $derived(data.minorTerms);
	const status = $derived(COMPANY_STATUSES[data.company.status]);
	const editable = $derived(overview !== null && (overview.status === 'draft' || overview.status === 'rejected'));
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];

	const VERIFICATION: Record<'pending' | 'approved' | 'rejected' | 'needs_info', string> = {
		pending: 'Заявка ждёт решения оператора',
		approved: 'Компания проверена',
		rejected: 'Заявка отклонена',
		needs_info: 'Оператор просит уточнить данные'
	};
</script>

<PageHeader title={data.company.displayName} description="Профиль компании и её проверка оператором ФСП.">
	{#snippet actions()}
		<StatusPill label={status.label} tone={status.tone} />
	{/snippet}
</PageHeader>

<CompanyTabs role={data.role} />

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'saved' in form}
	<FormMessage tone="success" text="Реквизиты сохранены." />
{:else if data.transferred}
	<FormMessage tone="success" text="Владение передано. Теперь вы — рекрутер компании." />
{:else if form && 'minorTermsAccepted' in form}
	<FormMessage
		tone="success"
		text="Оферта принята. Теперь в вакансии можно указать минимальный возраст кандидатов 14, 15 или 16 лет."
	/>
{:else if form && 'submitted' in form}
	<FormMessage tone="success" text="Заявка подана. Оператор ФСП проверит ИНН и полномочия; решение придёт письмом." />
{/if}

{#if overview === null}
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Статус компании</h2></Card.Title>
			<Card.Description>
				Реквизиты и проверку ведёт владелец компании. Вы — рекрутер: вам доступны вакансии, подбор и приглашения.
			</Card.Description>
		</Card.Header>
	</Card.Root>
{:else}
	<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Реквизиты</h2></Card.Title>
				<Card.Description>
					{editable
						? 'Реквизиты можно менять до подачи заявки и после отказа или просьбы уточнить.'
						: 'Реквизиты проверяемой или проверенной компании не редактируются.'}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/update" use:enhance class="grid gap-4">
					<CsrfInput />
					<fieldset disabled={!editable} class="grid gap-4">
						<Field.Field data-invalid={fieldError('displayName') !== undefined}>
							<Field.Label for="company-display">Название для интерфейса</Field.Label>
							<Input id="company-display" name="displayName" value={overview.displayName} required />
							{#if fieldError('displayName')}<Field.Error>{fieldError('displayName')}</Field.Error>{/if}
						</Field.Field>
						<Field.Field data-invalid={fieldError('legalName') !== undefined}>
							<Field.Label for="company-legal">Полное наименование</Field.Label>
							<Input id="company-legal" name="legalName" value={overview.legalName} required />
							{#if fieldError('legalName')}<Field.Error>{fieldError('legalName')}</Field.Error>{/if}
						</Field.Field>
						<div class="grid gap-4 sm:grid-cols-3">
							<Field.Field data-invalid={fieldError('inn') !== undefined}>
								<Field.Label for="company-inn">ИНН</Field.Label>
								<Input id="company-inn" name="inn" value={overview.inn} inputmode="numeric" required />
								{#if fieldError('inn')}<Field.Error>{fieldError('inn')}</Field.Error>{/if}
							</Field.Field>
							<Field.Field data-invalid={fieldError('ogrn') !== undefined}>
								<Field.Label for="company-ogrn">ОГРН / ОГРНИП</Field.Label>
								<Input id="company-ogrn" name="ogrn" value={overview.ogrn ?? ''} inputmode="numeric" />
								{#if fieldError('ogrn')}<Field.Error>{fieldError('ogrn')}</Field.Error>{/if}
							</Field.Field>
							<Field.Field data-invalid={fieldError('kpp') !== undefined}>
								<Field.Label for="company-kpp">КПП</Field.Label>
								<Input id="company-kpp" name="kpp" value={overview.kpp ?? ''} />
								{#if fieldError('kpp')}<Field.Error>{fieldError('kpp')}</Field.Error>{/if}
							</Field.Field>
						</div>
					</fieldset>
					{#if editable}
						<Button type="submit" variant="outline" class="justify-self-start">Сохранить реквизиты</Button>
					{/if}
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Проверка оператором ФСП</h2></Card.Title>
				<Card.Description>
					Только проверенная компания видит каталог кандидатов, публикует вакансии и приглашает.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				{#if overview.verification}
					{@const verification = overview.verification}
					<dl class="grid gap-2" data-testid="verification-state" data-state={verification.state}>
						<div>
							<dt class="text-muted-foreground">Последняя заявка</dt>
							<dd class="font-medium">{VERIFICATION[verification.state]}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Подана</dt>
							<dd>{formatDateTime(verification.submittedAt)}</dd>
						</div>
						{#if verification.decidedAt}
							<div>
								<dt class="text-muted-foreground">Решение</dt>
								<dd>{formatDateTime(verification.decidedAt)}</dd>
							</div>
						{/if}
						{#if verification.reason}
							<div>
								<dt class="text-muted-foreground">Ответ оператора</dt>
								<dd class="rounded-md border bg-muted/40 p-3 whitespace-pre-line">{verification.reason}</dd>
							</div>
						{/if}
					</dl>
				{:else}
					<p class="text-muted-foreground">Заявка на проверку ещё не подавалась.</p>
				{/if}
				{#if overview.verifiedAt}
					<p>Проверена {formatDate(overview.verifiedAt)}.</p>
				{/if}
				{#if editable}
					<form method="POST" action="?/submit" use:enhance class="grid gap-3 border-t pt-4">
						<CsrfInput />
						<p>
							Способ подтверждения полномочий: <span class="font-medium"
								>{AUTHORITY_METHODS.corporate_email_domain}</span
							>. Оператор сверит домен вашей учётной записи с сайтом компании.
						</p>
						<p class="text-muted-foreground">
							Подтверждение документом (доверенность, письмо руководителя, электронная подпись) станет доступно вместе с
							загрузкой файлов.
						</p>
						<Button type="submit" class="justify-self-start">
							{overview.verification ? 'Подать заявку снова' : 'Подать на проверку'}
						</Button>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if minorTerms}
			<Card.Root class="lg:col-span-2" data-testid="minor-terms">
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Вакансии для несовершеннолетних</h2></Card.Title>
					<Card.Description>
						Кандидатов 14–17 лет компания видит только в подборе к вакансии с указанным минимальным возрастом. Такую
						вакансию можно сохранить после оферты о соблюдении главы 42 ТК РФ.
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-4 text-sm">
					{#if minorTerms.accepted}
						<p data-testid="minor-terms-state" data-state="accepted">
							Оферта принята: редакция {minorTerms.accepted.version}, {formatDateTime(minorTerms.accepted.acceptedAt)}.
						</p>
					{:else if minorTerms.current}
						{@const current = minorTerms.current}
						<form method="POST" action="?/acceptMinorTerms" use:enhance class="grid gap-3">
							<CsrfInput />
							<input type="hidden" name="documentId" value={current.id} />
							<p data-testid="minor-terms-state" data-state="not_accepted">
								Прочитайте
								<a
									class="text-link underline underline-offset-4"
									href={resolve('/(auth)/documents/[kind]', { kind: 'minor_employment_terms' })}
									target="_blank"
									rel="noopener">«{current.title}»</a
								>
								(редакция {current.version}). Принимая её, вы как владелец компании обязуетесь соблюдать ограничения
								труда несовершеннолетних.
							</p>
							<Button type="submit" variant="outline" class="justify-self-start">Принять оферту</Button>
						</form>
					{:else}
						<p class="text-muted-foreground">
							Оферта ещё не опубликована — вакансии для несовершеннолетних недоступны.
						</p>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
{/if}
