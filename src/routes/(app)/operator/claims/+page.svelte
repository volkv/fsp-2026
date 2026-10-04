<script lang="ts">
	import { enhance } from '$app/forms';
	import LinkIcon from '@lucide/svelte/icons/link';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { CLAIM_STATUSES, COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import { CLAIM_INN } from '$lib/components/operator/model.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const failure = $derived(
		form && 'problem' in form && form.problem ? { claimId: form.claimId, message: form.problem.message } : null
	);
</script>

<PageHeader
	title="«Это наша вакансия»"
	description="Проверенная компания заявляет права на внешнюю вакансию. Одобрение позволяет ей создать собственную вакансию по внешней; приглашать по самой внешней нельзя."
/>

{#if form && 'decided' in form}
	<FormProblem
		tone="success"
		text={form.decided === 'approved'
			? 'Заявка одобрена: компания может создать свою вакансию по внешней.'
			: 'Заявка отклонена.'}
	/>
{/if}

{#if data.claims.awaitingCompany > 0}
	<p class="text-sm text-muted-foreground">
		Ещё {data.claims.awaitingCompany} заявок ждут проверки своей компании — они придут сюда после неё.
	</p>
{/if}

{#if data.claims.items.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><LinkIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Заявок на рассмотрении нет</Empty.Title>
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-4" aria-label="Заявки на рассмотрении">
		{#each data.claims.items as claim (claim.id)}
			{@const inn = CLAIM_INN[claim.evidence.inn]}
			{@const company = COMPANY_STATUSES[claim.company.status]}
			<li>
				<Card.Root data-claim={claim.id}>
					<Card.Header>
						<Card.Title><h2 class="font-heading text-h3">{claim.vacancy.title}</h2></Card.Title>
						<Card.Description>
							Внешняя вакансия{claim.vacancy.organization ? ` · ${claim.vacancy.organization}` : ''} · заявка от
							{formatDateTime(claim.submittedAt)}
						</Card.Description>
					</Card.Header>
					<Card.Content class="grid gap-4 text-sm lg:grid-cols-2">
						<dl class="grid gap-2">
							<div>
								<dt class="text-muted-foreground">Компания-заявитель</dt>
								<dd class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{claim.company.displayName}</span>
									<StatusPill label={company.label} tone={company.tone} />
								</dd>
								<dd class="text-muted-foreground">{claim.company.legalName}, ИНН {claim.company.inn}</dd>
							</div>
							<div>
								<dt class="text-muted-foreground">Заявитель</dt>
								<dd>{claim.requesterName ?? 'без имени'}</dd>
							</div>
							<div>
								<dt class="text-muted-foreground">Подсказка</dt>
								<dd><StatusPill label={inn.label} tone={inn.tone} /></dd>
								{#if claim.evidence.posting_inns.length > 0}
									<dd class="text-muted-foreground">ИНН в публикациях: {claim.evidence.posting_inns.join(', ')}</dd>
								{/if}
								<dd class="text-muted-foreground">
									Сходство названий: {percent.format(claim.evidence.name_similarity)}
								</dd>
							</div>
						</dl>
						<form method="POST" use:enhance class="grid gap-3" data-testid="claim-form">
							<CsrfInput />
							<input type="hidden" name="claimId" value={claim.id} />
							{#if failure?.claimId === claim.id}
								<FormProblem text={failure.message} />
							{/if}
							<Field.Field>
								<Field.Label for={`claim-reason-${claim.id}`}>
									{claim.evidence.inn === 'mismatch' ? 'Причина (обязательна)' : 'Причина (обязательна при отказе)'}
								</Field.Label>
								<Textarea id={`claim-reason-${claim.id}`} name="reason" rows={2} />
							</Field.Field>
							<div class="flex flex-wrap gap-2">
								<Button type="submit" formaction="?/approve">Одобрить</Button>
								<Button type="submit" variant="destructive" formaction="?/reject">Отклонить</Button>
							</div>
						</form>
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>
{/if}

{#if data.claims.decided.length > 0}
	<section aria-labelledby="decided-heading" class="grid gap-3">
		<h2 id="decided-heading" class="font-heading text-h3">Недавние решения</h2>
		<ul class="grid gap-2 text-sm">
			{#each data.claims.decided as claim (claim.id)}
				<li class="flex flex-wrap items-center gap-2">
					<StatusPill
						label={CLAIM_STATUSES[claim.status] ?? claim.status}
						tone={claim.status === 'approved' ? 'success' : 'danger'}
					/>
					<span>{claim.vacancyTitle} — {claim.companyName}</span>
					{#if claim.decidedAt}<span class="text-muted-foreground">{formatDateTime(claim.decidedAt)}</span>{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
