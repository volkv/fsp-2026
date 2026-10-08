<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ContactRoundIcon from '@lucide/svelte/icons/contact-round';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import TrendingDownIcon from '@lucide/svelte/icons/trending-down';
	import ContactsHidden from '$lib/components/employer/contacts-hidden.svelte';
	import OfferForm from '$lib/components/employer/offer-form.svelte';
	import {
		DISCLOSURE_FIELD_LABELS,
		TERMS_FIELD_LABELS,
		disclosedFields,
		hiringView
	} from '$lib/components/employer/model.js';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import OfferConversation from '$lib/components/product/offer-conversation.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { HiringStages, InvitationStatus, ResponseDeadline, SalaryRange } from '$lib/components/product/index.js';
	import { HIRING_OUTCOMES, HIRING_STAGES, formatDateTime } from '$lib/components/product/model.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const invitation = $derived(data.invitation);
	const current = $derived(invitation.versions.find((version) => version.id === invitation.currentTermsId));
	const open = $derived(invitation.status === 'sent' || invitation.status === 'viewed');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const process = $derived(data.process);
	// The conversation opens with the acceptance; a closed offer without messages has none to show.
	const showConversation = $derived(invitation.status === 'accepted' || data.conversation.messages.length > 0);
	const stageLabel = (key: string) => HIRING_STAGES.find((stage) => stage.key === key)?.label ?? key;

	const named = (fields: readonly string[]) =>
		fields.map((field) => DISCLOSURE_FIELD_LABELS[field] ?? field).join(', ');

	const RESPONSE = { accept: 'Принято', decline: 'Отклонено' } as const;

	function changeValue(value: unknown): string {
		if (value === null || value === undefined || value === '') return '—';
		if (Array.isArray(value)) return value.map((item) => changeValue(item)).join(', ');
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		return JSON.stringify(value);
	}
</script>

<PageHeader
	title={`Приглашение: ${invitation.candidatePseudonym ?? ''}`}
	description={current
		? `${current.title}${current.vacancy ? ` · вакансия «${current.vacancy.snapshot.title}»` : ''}`
		: ''}
>
	{#snippet eyebrow()}
		<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/invitations')}>Приглашения</a>
	{/snippet}
	{#snippet actions()}
		<InvitationStatus status={invitation.status} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if data.sent && !form}
	<FormMessage
		tone="success"
		text="Приглашение отправлено. Кандидат получил уведомление без имён и сумм — детали видны только в кабинете."
	/>
{:else if form && 'revised' in form && form.revised}
	<FormMessage
		tone="success"
		text={`Отправлена версия ${form.revised.version}. Кандидат увидит отличия от предыдущей${form.revised.lowered ? ' и пометку о снижении предложения' : ''}.`}
	/>
{:else if form && 'withdrawn' in form}
	<FormMessage tone="success" text="Приглашение отозвано." />
{:else if form && 'reported' in form}
	<FormMessage tone="success" text="Отметка сохранена." />
{/if}

{#if invitation.awaitingRepresentative}
	{@const awaiting = invitation.awaitingRepresentative}
	<Alert.Root class="mb-6 border-warning/40 bg-warning-subtle" data-testid="awaiting-representative">
		<Alert.Title>Кандидат принял приглашение — ждём согласия законного представителя</Alert.Title>
		<Alert.Description>
			Принятие отмечено {formatDateTime(awaiting.requestedAt)}. Контакты откроются, когда представитель согласится, — не
			позже {formatDateTime(awaiting.dueAt)}; если он не ответит к этому сроку, приглашение истечёт. Пересмотр условий
			или отзыв приглашения прервут ожидание.
		</Alert.Description>
	</Alert.Root>
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid content-start gap-6">
		{#if current}
			<Card.Root data-testid="current-terms">
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Текущие условия · версия {current.version}</h2></Card.Title>
					<Card.Description
						>Отправлены {formatDateTime(current.createdAt)}. Отправленные условия не меняются.</Card.Description
					>
				</Card.Header>
				<Card.Content class="grid gap-3 text-sm">
					<p class="font-medium">{current.title}</p>
					<SalaryRange salary={current.salary} size="lg" />
					{#if open}
						<ResponseDeadline dueAt={current.responseDueAt} />
					{/if}
					<p class="whitespace-pre-line">{current.description}</p>
					<dl class="grid gap-1">
						<div class="flex flex-wrap gap-1">
							<dt class="text-muted-foreground">Формат:</dt>
							<dd>{data.labels.terms.work_format[current.workFormat] ?? current.workFormat}</dd>
						</div>
						<div class="flex flex-wrap gap-1">
							<dt class="text-muted-foreground">Вакансия:</dt>
							<dd>{current.vacancy ? `«${current.vacancy.snapshot.title}»` : 'без вакансии'}</dd>
						</div>
						<div class="flex flex-wrap gap-1">
							<dt class="text-muted-foreground">Грейд кандидата:</dt>
							<dd data-testid="offer-category">
								{current.category
									? `${data.labels.specializations[current.category.specialization] ?? current.category.specialization} · ${data.labels.grades[current.category.grade] ?? current.category.grade} — подтверждён тестом`
									: 'не подтверждён тестом — оцените уровень на собеседовании'}
							</dd>
						</div>
						<div class="flex flex-wrap gap-1">
							<dt class="text-muted-foreground">Связь:</dt>
							<dd>
								{current.contactMethod.value}{current.contactMethod.note ? ` — ${current.contactMethod.note}` : ''}
							</dd>
						</div>
					</dl>
					<div class="grid gap-1" data-testid="why-you">
						<p class="text-muted-foreground">Почему вы:</p>
						<ul class="list-disc pl-5">
							{#each current.whyYou as point, index (index)}
								<li>{point.text}</li>
							{/each}
						</ul>
					</div>
					{#if current.message}
						<p class="rounded-md border bg-muted/40 p-3 whitespace-pre-line">{current.message}</p>
					{/if}
					{#if invitation.viewedAt}
						<p class="text-muted-foreground">Кандидат открыл приглашение {formatDateTime(invitation.viewedAt)}.</p>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if showConversation}
			<Card.Root data-testid="conversation">
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<MessagesSquareIcon class="size-5" aria-hidden="true" />
						<h2 class="font-heading text-h3">Переписка с кандидатом</h2>
					</Card.Title>
					<Card.Description>
						Кандидат принял приглашение — это согласие пообщаться, а не принятие оффера. Переписку видят кандидат и
						сотрудники вашей компании; при отзыве согласия кандидатом она закрывается.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<OfferConversation
						conversation={data.conversation}
						otherName={invitation.candidatePseudonym ?? 'Кандидат'}
						reader="company"
					/>
				</Card.Content>
			</Card.Root>
		{/if}

		<section class="grid gap-3" aria-labelledby="versions-heading">
			<h2 id="versions-heading" class="font-heading text-h3">История условий</h2>
			<ol class="grid gap-3">
				{#each [...invitation.versions].reverse() as version (version.id)}
					<li class="grid gap-2 rounded-xl border bg-card p-4 text-sm" data-version={version.version}>
						<div class="flex flex-wrap items-center justify-between gap-2">
							<p class="font-medium">Версия {version.version} · {formatDateTime(version.createdAt)}</p>
							{#if version.response}
								<span class="text-muted-foreground">
									{RESPONSE[version.response.decision]}
									{formatDateTime(version.response.respondedAt)}
								</span>
							{:else if version.id === invitation.acceptedTermsId}
								<span class="text-success">Принятая версия</span>
							{/if}
						</div>
						<SalaryRange salary={version.salary} />
						{#if version.changes}
							{#if version.changes.salary_lowered}
								<p class="flex items-center gap-1.5 text-warning">
									<TrendingDownIcon class="size-4" aria-hidden="true" />
									Ниже предыдущего предложения этой компании (версии {version.changes.lowered_against_versions.join(
										', '
									)})
								</p>
							{/if}
							{#if version.changes.fields.length > 0}
								<ul class="grid gap-1 text-muted-foreground">
									{#each version.changes.fields as change (change.field)}
										<li>
											{TERMS_FIELD_LABELS[change.field] ?? change.field}: {changeValue(change.from)} →
											<span class="text-foreground">{changeValue(change.to)}</span>
										</li>
									{/each}
								</ul>
							{/if}
						{/if}
						{#if version.response?.reasonText}
							<p class="text-muted-foreground">Причина кандидата: {version.response.reasonText}</p>
						{/if}
					</li>
				{/each}
			</ol>
		</section>
	</div>

	<aside class="grid content-start gap-6">
		{#if data.application}
			<p class="rounded-lg border p-3 text-sm" data-testid="contacts-by-application">
				Кандидат откликнулся на вашу вакансию «{data.application.vacancyTitle}» — контакты, которые он выбрал, в
				<a
					class="text-link underline"
					href={resolve('/(app)/company/(member)/applications/[id]', { id: data.application.id })}>отклике</a
				>.
			</p>
		{:else if invitation.status !== 'accepted' && !invitation.awaitingRepresentative}
			<ContactsHidden closed={!open} />
		{/if}
		{#if invitation.status === 'accepted'}
			<Card.Root data-testid="contacts">
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<ContactRoundIcon class="size-5" aria-hidden="true" />
						<h2 class="font-heading text-h3">Контакты кандидата</h2>
					</Card.Title>
					<Card.Description>
						Раскрыты только вашей компании и только выбранные кандидатом поля. Каждый просмотр записывается в журнал.
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-2 text-sm">
					{#if data.contacts}
						{@const contacts = data.contacts}
						<dl class="grid gap-2">
							{#if contacts.fullName}
								<div>
									<dt class="text-muted-foreground">ФИО</dt>
									<dd class="font-medium">
										{[contacts.fullName.last, contacts.fullName.first, contacts.fullName.middle]
											.filter(Boolean)
											.join(' ')}
									</dd>
								</div>
							{/if}
							{#if contacts.email}
								<div>
									<dt class="text-muted-foreground">Почта</dt>
									<dd><a class="text-link underline" href={`mailto:${contacts.email}`}>{contacts.email}</a></dd>
								</div>
							{/if}
							{#if contacts.phone}
								<div>
									<dt class="text-muted-foreground">Телефон</dt>
									<dd>{contacts.phone}</dd>
								</div>
							{/if}
							{#if contacts.telegram}
								<div>
									<dt class="text-muted-foreground">Telegram</dt>
									<dd>{contacts.telegram}</dd>
								</div>
							{/if}
						</dl>
						{@const split = disclosedFields(contacts)}
						<p class="text-xs text-muted-foreground" data-testid="disclosed-fields">
							Раскрыто: {named(split.disclosed)}.
							{#if split.empty.length > 0}
								Кандидат разрешил, но не указал в профиле: {named(split.empty)}.
							{/if}
						</p>
					{:else}
						<Alert.Root>
							<Alert.Description>
								Кандидат отозвал согласие на раскрытие контактов: платформа их больше не показывает.
							</Alert.Description>
						</Alert.Root>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if process}
			<Card.Root data-testid="hiring">
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Процесс найма</h2></Card.Title>
					<Card.Description>
						Каждая сторона сама отмечает этапы и исход; молчание — не исход.
						{#if process.overdue}Срок сообщить исход прошёл.{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-4">
					<HiringStages hiring={hiringView(process.outcome, process.reports)} />
					{#if process.otherSideDiffers}
						<Alert.Root class="border-warning/40 bg-warning-subtle">
							<Alert.Description
								>Кандидат отметил исход иначе, чем компания. Уточните с ним и при необходимости исправьте свою отметку.</Alert.Description
							>
						</Alert.Root>
					{/if}
					<form method="POST" action="?/report" use:enhance class="grid gap-2">
						<CsrfInput />
						<input type="hidden" name="processId" value={process.id} />
						<input type="hidden" name="kind" value="stage" />
						<Field.Field>
							<Field.Label for="report-stage">Отметить этап</Field.Label>
							<NativeSelect id="report-stage" name="stage">
								{#each data.stages as stage (stage)}
									<option value={stage}>{stageLabel(stage)}</option>
								{/each}
							</NativeSelect>
						</Field.Field>
						<Button type="submit" variant="outline" class="justify-self-start">Сообщить этап</Button>
					</form>
					<form method="POST" action="?/report" use:enhance class="grid gap-2 border-t pt-4">
						<CsrfInput />
						<input type="hidden" name="processId" value={process.id} />
						<input type="hidden" name="kind" value="outcome" />
						<Field.Field>
							<Field.Label for="report-outcome">Исход</Field.Label>
							<NativeSelect id="report-outcome" name="outcome">
								{#each data.outcomes as outcome (outcome)}
									<option value={outcome}>{HIRING_OUTCOMES[outcome]}</option>
								{/each}
							</NativeSelect>
						</Field.Field>
						<Field.Field>
							<Field.Label for="report-start">Дата выхода (при найме)</Field.Label>
							<Input id="report-start" name="startDate" type="date" />
						</Field.Field>
						<Button type="submit" variant="outline" class="justify-self-start">Сообщить исход</Button>
					</form>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if current && data.offer.profileComplete}
			<Card.Root>
				<Card.Header>
					<Card.Title>
						<h2 class="font-heading text-h3">
							{open || invitation.status === 'accepted' ? 'Пересмотреть условия' : 'Предложить снова'}
						</h2>
					</Card.Title>
					<Card.Description>
						{invitation.status === 'accepted'
							? 'Принятая версия остаётся в силе, пока кандидат не ответит на новую.'
							: 'Новая версия не меняет отправленную: кандидат увидит обе и отличия между ними.'}
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<OfferForm
						action="?/revise"
						vacancies={data.offer.vacancies}
						workFormats={data.offer.workFormats}
						whyYouOptions={data.whyYouOptions}
						initial={{
							title: current.title,
							description: current.description,
							salaryMin: current.salary.min,
							salaryMax: current.salary.max,
							taxBase: current.salary.taxBase,
							workFormat: current.workFormat,
							contactKind: current.contactMethod.kind,
							contactValue: current.contactMethod.value,
							contactNote: current.contactMethod.note,
							vacancyId: current.vacancy?.id ?? null,
							message: current.message,
							whyYou: data.whyYouOptions.map((option) => option.key)
						}}
						responseWindowHours={data.offer.responseWindowHours}
						problems={problem?.fields ?? {}}
						submitLabel="Отправить новую версию"
					/>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if open}
			<form method="POST" action="?/withdraw" use:enhance>
				<CsrfInput />
				<Button type="submit" variant="ghost" class="text-destructive">Отозвать приглашение</Button>
			</form>
		{/if}
	</aside>
</div>
