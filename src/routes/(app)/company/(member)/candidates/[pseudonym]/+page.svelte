<script lang="ts">
	import { candidateLabel } from '$lib/text/candidate-label';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CandidateCard from '$lib/components/employer/candidate-card.svelte';
	import ContactsHidden from '$lib/components/employer/contacts-hidden.svelte';
	import OfferForm from '$lib/components/employer/offer-form.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { InvitationStatus, RecommendationNotice } from '$lib/components/product/index.js';
	import { categoryName } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const CONFIRMATION_STATUS = {
		requested: 'Ждёт ответа',
		accepted: 'Блок-тест идёт',
		declined: 'Отказ',
		completed: 'Завершён',
		expired: 'Срок истёк'
	} as const;
</script>

<PageHeader
	title={candidateLabel(data.pseudonym)}
	description="Псевдоним виден только вашей компании. Имя и контакты — после принятия предложения и только с согласия кандидата."
>
	{#snippet eyebrow()}
		{#if data.fromShortlist?.shortlistId}
			<a
				class="text-link underline-offset-4 hover:underline"
				href={resolve('/(app)/company/(member)/shortlists/[id]', { id: data.fromShortlist.shortlistId })}>Подборка</a
			>
		{:else}
			<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/candidates')}>Кандидаты</a>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<CandidateCard
		card={data.card}
		evidenceState={data.evidenceState}
		receipts={data.receipts}
		labels={data.labels}
		signals={data.signals}
	/>
	<aside class="grid content-start gap-4">
		<RecommendationNotice compact />
		{#if data.application}
			<p class="rounded-lg border p-3 text-sm" data-testid="contacts-by-application">
				Кандидат откликнулся на вакансию «{data.application.vacancyTitle}» — контакты, которые он выбрал, в
				<a
					class="text-link underline"
					href={resolve('/(app)/company/(member)/applications/[id]', { id: data.application.id })}>отклике</a
				>.
			</p>
		{:else if data.invitation?.status !== 'accepted'}
			<ContactsHidden />
		{/if}
		<Card.Root data-tour="candidate-offer">
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Предложить работу</h2></Card.Title>
				<Card.Description>
					Компания пишет первой: описание, вилка в рублях, способ связи и «почему вы». Вакансия — по желанию.
					{#if data.fromShortlist}
						Пункты «почему вы» отмечены по подборке — каждый со своим источником.
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4">
				{#if problem}
					<FormMessage text={problem.message} />
				{/if}
				{#if data.fromShortlist && !data.fromShortlist.gradeConfirmed}
					<p class="rounded-lg border border-dashed p-3 text-sm" data-testid="offer-grade-not-confirmed">
						Грейд кандидата не подтверждён тестом{data.fromShortlist.declared
							? ` — указано кандидатом: ${categoryName(data.fromShortlist.declared, data.labels)}`
							: ''}. Предложение это покажет: категория в нём — «не подтверждена». Уровень оцените на собеседовании или
						запросите подтверждение блока.
					</p>
				{/if}
				{#if data.invitation}
					<div class="flex flex-wrap items-center gap-2 text-sm" data-testid="existing-invitation">
						<InvitationStatus status={data.invitation.status} />
						<span class="text-muted-foreground">
							Предложение этому кандидату уже есть: новые условия — его новая версия.
						</span>
					</div>
					<a
						class={buttonVariants({ variant: 'outline' })}
						href={resolve('/(app)/company/(member)/invitations/[id]', { id: data.invitation.id })}
					>
						Открыть предложение
					</a>
				{:else if !data.offer.profileComplete}
					<p class="text-sm text-muted-foreground" data-testid="profile-incomplete">
						Кандидат увидит профиль компании в предложении. Заполните описание и направление деятельности в
						<a class="text-link underline" href={resolve('/company/profile')}>профиле компании</a>.
					</p>
				{:else}
					<OfferForm
						action="?/offer"
						vacancies={data.offer.vacancies}
						workFormats={data.offer.workFormats}
						whyYouOptions={data.whyYouOptions}
						preselected={[...data.preselected, ...(data.fromShortlist?.preselected ?? [])]}
						needId={data.fromShortlist?.needId ?? null}
						needTerms={data.fromShortlist?.needTerms ?? null}
						responseWindowHours={data.offer.responseWindowHours}
						problems={problem?.fields ?? {}}
					/>
				{/if}
			</Card.Content>
		</Card.Root>
		<Card.Root data-testid="confirmation-request">
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Запросить подтверждение</h2></Card.Title>
				<Card.Action>
					<a class="text-sm text-link underline-offset-4 hover:underline" href={resolve('/company/confirmations')}
						>Все запросы</a
					>
				</Card.Action>
				<Card.Description>
					Блок, которого нет в категории кандидата: он проходит короткий блок-тест по желанию. Результат — отдельное
					доказательство, категорию не меняет; подтверждённый блок можно назвать в «почему вы».
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3">
				{#if form && 'confirmation' in form}
					<FormMessage
						tone="success"
						text={form.confirmation === 'result'
							? 'Результат этого блока уже есть и виден компании — новый тест не нужен.'
							: form.confirmation === 'existing'
								? 'Запрос этого блока уже открыт.'
								: 'Запрос отправлен кандидату.'}
					/>
				{/if}
				{#if data.confirmations.length > 0}
					<ul class="grid gap-1 text-sm">
						{#each data.confirmations as request (request.id)}
							<li class="flex flex-wrap items-center justify-between gap-2">
								<span>{request.blockTitle} · {data.names.grades[request.grade]}</span>
								<StatusPill
									label={request.result
										? request.result.status === 'annulled'
											? 'Результат аннулирован'
											: request.result.verdict === 'confirmed'
												? 'Подтверждено'
												: 'Не подтверждено'
										: CONFIRMATION_STATUS[request.status]}
									tone={request.result?.verdict === 'confirmed' && request.result.status === 'valid'
										? 'success'
										: 'neutral'}
								/>
							</li>
						{/each}
					</ul>
				{/if}
				{#if data.requestable.length === 0}
					<p class="text-sm text-muted-foreground">
						Блоков для запроса нет: у кандидата нет категории или заявленного грейда открытой специализации, либо все
						блоки грейда уже подтверждены.
					</p>
				{:else}
					<form method="POST" action="?/requestConfirmation" use:enhance class="grid gap-2">
						<CsrfInput />
						<NativeSelect name="block" aria-label="Блок">
							{#each data.requestable as block (block.block)}
								<option value={block.block}>{block.title} · {data.names.grades[block.grade]}</option>
							{/each}
						</NativeSelect>
						<Button type="submit" variant="outline" size="sm" class="justify-self-start">Запросить</Button>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
		{#if data.vacancies.length > 0}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Соответствие вакансиям</h2></Card.Title>
					<Card.Description>Разбор соответствия считается по требованиям конкретной вакансии.</Card.Description>
				</Card.Header>
				<Card.Content>
					<ul class="grid gap-2">
						{#each data.vacancies as vacancy (vacancy.id)}
							<li>
								<a
									class="text-sm font-medium text-link underline-offset-4 hover:underline"
									href={resolve('/(app)/company/(member)/vacancies/[id]/candidates/[pseudonym]', {
										id: vacancy.id,
										pseudonym: data.pseudonym
									})}
									data-sveltekit-preload-data="tap"
								>
									{vacancy.title}
								</a>
							</li>
						{/each}
					</ul>
				</Card.Content>
			</Card.Root>
		{/if}
	</aside>
</div>
