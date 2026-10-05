<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import { COMPLAINT_DECISIONS, COMPLAINT_REASONS } from '$lib/components/operator/model.js';
	import { InvitationStatus, SalaryRange, TrustFacts } from '$lib/components/product/index.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const c = $derived(data.complaint);
	const decision = $derived(c.decision ? COMPLAINT_DECISIONS[c.decision] : undefined);
	const companyStatus = $derived(COMPANY_STATUSES[c.company.status]);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];
</script>

<PageHeader title="Жалоба на предложение" description={`Подана ${formatDateTime(c.createdAt)}.`}>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/complaints')}>Жалобы на предложения</a>
	{/snippet}
	{#snippet actions()}
		{#if decision}
			<StatusPill label={decision.label} tone={decision.tone} />
		{:else}
			<StatusPill label="Открыта" tone="info" />
		{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'decided' in form}
	<FormMessage tone="success" text="Решение принято: кандидат получил уведомление с объяснением." />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-complaint={c.id} data-status={c.status}>
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Что пишет кандидат</h2></Card.Title>
				<Card.Description>{COMPLAINT_REASONS[c.reasonCode] ?? c.reasonCode}</Card.Description>
			</Card.Header>
			<Card.Content>
				<blockquote class="border-l-2 pl-4 text-sm whitespace-pre-line" data-testid="complaint-text">
					{c.text}
				</blockquote>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Предложение</h2></Card.Title>
				<Card.Description>Все версии условий; отмечена та, что действовала в момент жалобы.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				<InvitationStatus status={c.offer.status} />
				<ol class="grid gap-2">
					{#each c.offer.versions as version (version.id)}
						<li class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3">
							<span class="font-medium">Версия {version.version}</span>
							<span>{version.title}</span>
							<SalaryRange salary={version.salary} />
							<span class="text-muted-foreground">{formatDateTime(version.createdAt)}</span>
							{#if version.id === c.offer.complainedTermsId}
								<StatusPill label="в момент жалобы" tone="info" />
							{/if}
						</li>
					{/each}
				</ol>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">{c.company.displayName}</h2></Card.Title>
				<Card.Description>
					ИНН {c.company.inn} · {companyStatus.label}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				<p>
					Жалоб на компанию: открыто {c.companyComplaints.open}, обоснованных {c.companyComplaints.upheld}, без
					последствий
					{c.companyComplaints.dismissed}.
				</p>
				<a
					class="underline-offset-4 hover:underline"
					href={resolve('/(app)/operator/companies/[id]', { id: c.company.id })}>Карточка компании</a
				>
				<TrustFacts trust={c.trust} />
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Решение</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				{#if c.status === 'decided'}
					<div class="grid gap-2 text-sm">
						{#if c.decidedAt}<p class="text-muted-foreground">Принято {formatDateTime(c.decidedAt)}</p>{/if}
						{#if c.resolution}<blockquote class="border-l-2 pl-3 whitespace-pre-line">{c.resolution}</blockquote>{/if}
					</div>
				{:else}
					<form method="POST" action="?/decide" use:enhance class="grid gap-4">
						<CsrfInput />
						<Field.Set>
							<Field.Legend variant="label">Исход</Field.Legend>
							<div class="grid gap-2 text-sm">
								<label class="flex items-center gap-2">
									<input type="radio" name="decision" value="no_action" required class="size-4 accent-primary" />
									Без последствий
								</label>
								<label class="flex items-center gap-2">
									<input type="radio" name="decision" value="warning" class="size-4 accent-primary" />
									Предупреждение компании
								</label>
								<label class="flex items-center gap-2">
									<input
										type="radio"
										name="decision"
										value="suspension"
										disabled={!c.company.suspendable}
										class="size-4 accent-primary"
									/>
									Приостановить компанию
									{#if !c.company.suspendable}<span class="text-xs text-muted-foreground">— уже закрыта</span>{/if}
								</label>
							</div>
							{#if fieldError('decision')}<Field.Error>{fieldError('decision')}</Field.Error>{/if}
						</Field.Set>
						<Field.Field data-invalid={fieldError('resolution') !== undefined}>
							<Field.Label for="complaint-resolution">Объяснение для кандидата</Field.Label>
							<Textarea id="complaint-resolution" name="resolution" minlength={10} maxlength={2000} rows={4} required />
							<Field.Description>
								Кандидат прочитает его на странице предложения. Компании уходит только причина обоснованной жалобы.
							</Field.Description>
							{#if fieldError('resolution')}<Field.Error>{fieldError('resolution')}</Field.Error>{/if}
						</Field.Field>
						<Button type="submit" class="justify-self-start">Принять решение</Button>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
