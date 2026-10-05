<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import { DECISIONS, SUSPENSION_REASONS } from '$lib/components/operator/model.js';
	import PartnershipForm from '$lib/components/operator/partnership-form.svelte';
	import PartnershipList from '$lib/components/operator/partnership-list.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const card = $derived(data.card);
	const status = $derived(COMPANY_STATUSES[card.status]);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const DONE: Record<string, string> = {
		suspended: 'Компания приостановлена: каталог, пулы, ключи API и неотвеченные приглашения закрыты.',
		reinstated: 'Компания снова работает: каталог, вакансии и предложения открыты.',
		partnership_opened: 'Партнёрство открыто.',
		partnership_ended: 'Партнёрство завершено: пул закрыт.'
	};
	const done = $derived(form && 'done' in form && form.done ? DONE[form.done] : null);
	const titles = $derived(Object.fromEntries(data.competitions.map((c) => [c.ref, c.title])));
	const openRequest = $derived(card.verifications.find((v) => v.decision === null) ?? null);
	/** A working company — verified or acting without a check — may be suspended (domain 5.1). */
	const working = $derived(card.status === 'verified' || card.status === 'submitted' || card.status === 'draft');
</script>

<PageHeader title={card.displayName} description={card.legalName}>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/companies')}>Проверка компаний</a>
	{/snippet}
	{#snippet actions()}
		<StatusPill label={status.label} tone={status.tone} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormProblem text={problem.message} />
{:else if done}
	<FormProblem tone="success" text={done} />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Компания</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				<dl class="grid gap-3 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-muted-foreground">ИНН</dt>
						<dd class="font-mono">{card.inn}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">ОГРН</dt>
						<dd class="font-mono">{card.ogrn ?? '—'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">КПП</dt>
						<dd class="font-mono">{card.kpp ?? '—'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Проверена</dt>
						<dd>{card.verifiedAt ? formatDate(card.verifiedAt) : 'нет'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Команда</dt>
						<dd>владельцев: {card.activeMembers.owners}, рекрутеров: {card.activeMembers.recruiters}</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Партнёрства с соревнованиями</h2></Card.Title>
				<Card.Description>
					Партнёр видит пул участников соревнования по их согласию. Партнёрство открывает только оператор.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-6">
				{#if data.partnerships.length > 0}
					<PartnershipList partnerships={data.partnerships} competitionTitles={titles} showCompany={false} />
				{:else}
					<p class="text-sm text-muted-foreground">Партнёрств нет.</p>
				{/if}
				{#if card.status === 'verified'}
					<div class="border-t pt-4">
						<h3 class="mb-3 font-medium">Открыть партнёрство</h3>
						<PartnershipForm
							competitions={data.competitions}
							companyId={card.id}
							today={data.today}
							fields={problem?.fields ?? {}}
						/>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">Открыть партнёрство можно только проверенной компании.</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Модерация</h2></Card.Title>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				{#if working}
					{#if openRequest}
						<a
							class="text-link underline-offset-4 hover:underline"
							href={resolve('/(app)/operator/companies/requests/[id]', { id: openRequest.id })}
							>Открыть заявку на проверку</a
						>
					{/if}
					<form method="POST" action="?/suspend" use:enhance class="grid gap-3" data-testid="suspend-form">
						<CsrfInput />
						<p class="text-muted-foreground">
							Приостановка сразу закрывает каталог, пулы партнёров, ключи API и неотвеченные приглашения. Идущие
							процессы найма остаются: кандидат по-прежнему сообщает исход.
						</p>
						<Field.Field data-invalid={problem?.fields.reasonCode !== undefined}>
							<Field.Label for="suspend-reason">Причина</Field.Label>
							<NativeSelect id="suspend-reason" name="reasonCode" required>
								<option value="">Выберите причину</option>
								{#each Object.entries(SUSPENSION_REASONS) as [key, label] (key)}
									<option value={key}>{label}</option>
								{/each}
							</NativeSelect>
							{#if problem?.fields.reasonCode}<Field.Error>{problem.fields.reasonCode}</Field.Error>{/if}
						</Field.Field>
						<Button type="submit" variant="destructive" class="justify-self-start">Приостановить</Button>
					</form>
				{:else if card.status === 'suspended'}
					<form method="POST" action="?/reinstate" use:enhance class="grid gap-3">
						<CsrfInput />
						<p class="text-muted-foreground">
							Возврат снова открывает компании каталог, вакансии и предложения; метка проверки остаётся прежней.
						</p>
						<Button type="submit" class="justify-self-start">Вернуть к работе</Button>
					</form>
				{:else}
					<p class="text-muted-foreground">Проверка компании отклонена: её действия закрыты.</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Заявки на проверку</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				{#if card.verifications.length === 0}
					<p class="text-sm text-muted-foreground">Заявок не было.</p>
				{:else}
					<ol class="grid gap-3 text-sm">
						{#each card.verifications as item (item.id)}
							{@const decision = item.decision ? DECISIONS[item.decision] : null}
							<li class="grid gap-1 border-b pb-3 last:border-0">
								<span class="flex flex-wrap items-center gap-2">
									<a
										class="underline-offset-4 hover:underline"
										href={resolve('/(app)/operator/companies/requests/[id]', { id: item.id })}
										>{formatDateTime(item.submittedAt)}</a
									>
									{#if decision}<StatusPill label={decision.label} tone={decision.tone} />{:else}<StatusPill
											label="Ждёт решения"
											tone="info"
										/>{/if}
								</span>
								{#if item.reason}<p class="whitespace-pre-line text-muted-foreground">{item.reason}</p>{/if}
							</li>
						{/each}
					</ol>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
