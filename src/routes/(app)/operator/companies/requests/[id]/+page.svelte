<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { AUTHORITY_METHODS, COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import DueStatus from '$lib/components/operator/due-status.svelte';
	import {
		DECISIONS,
		REGISTRY_SOURCES,
		REGISTRY_STATES,
		REGISTRY_UNAVAILABLE
	} from '$lib/components/operator/model.js';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const v = $derived(data.verification);
	const company = $derived(v.company);
	const check = $derived(v.registryCheck);
	const registry = $derived(REGISTRY_STATES[check?.status ?? 'pending']);
	const record = $derived(data.registryRecord);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];
	const open = $derived(v.state === 'pending' && company.status === 'submitted');
	const DECIDED: Record<string, string> = {
		approve: 'Компания подтверждена: каталог, вакансии и приглашения ей открыты.',
		reject: 'Заявка отклонена, причина отправлена владельцу.',
		request_info: 'Заявка возвращена владельцу на уточнение.'
	};
	const size = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} КБ`;
	const same = (a: string | null | undefined, b: string | null | undefined) =>
		(a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
</script>

<PageHeader title={company.displayName} description="Заявка на проверку компании.">
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/companies')}>Проверка компаний</a>
	{/snippet}
	{#snippet actions()}
		<StatusPill label={COMPANY_STATUSES[company.status].label} tone={COMPANY_STATUSES[company.status].tone} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormProblem text={problem.message} />
{:else if data.decided && DECIDED[data.decided]}
	<FormProblem tone="success" text={DECIDED[data.decided] ?? ''} />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Реквизиты заявителя и реестр</h2></Card.Title>
				<Card.Description>
					Реестр — подсказка: найденная по ИНН организация не доказывает, что заявитель вправе действовать от её имени.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				<div
					class="flex flex-wrap items-center gap-2"
					data-testid="registry-state"
					data-state={check?.status ?? 'pending'}
				>
					{#if registry}<StatusPill label={registry.label} tone={registry.tone} />{/if}
					{#if check}
						<span class="text-muted-foreground">
							{check.source ? (REGISTRY_SOURCES[check.source] ?? check.source) : 'источник не подключён'} · проверено
							{formatDateTime(check.checked_at)}
						</span>
					{/if}
				</div>
				{#if check?.status === 'unavailable' && check.reason}
					<p class="text-warning">
						Причина: {REGISTRY_UNAVAILABLE[check.reason] ?? check.reason}. Сверьте ИНН вручную.
					</p>
				{/if}
				{#if check?.status === 'not_configured'}
					<p class="text-muted-foreground">
						Автоматическая сверка выключена настройкой. Сверьте ИНН, ОГРН и руководителя по выписке ФНС вручную.
					</p>
				{/if}
				<table class="w-full text-left">
					<caption class="sr-only">Реквизиты из заявки и из реестра</caption>
					<thead class="text-muted-foreground">
						<tr>
							<th scope="col" class="py-1 pr-3 font-normal">Поле</th>
							<th scope="col" class="py-1 pr-3 font-normal">В заявке</th>
							<th scope="col" class="py-1 font-normal">В реестре</th>
						</tr>
					</thead>
					<tbody class="align-top">
						<tr class="border-t">
							<th scope="row" class="py-2 pr-3 font-normal text-muted-foreground">ИНН</th>
							<td class="py-2 pr-3 font-mono">{company.inn}</td>
							<td class="py-2 font-mono">{record?.inn ?? '—'}</td>
						</tr>
						<tr class="border-t">
							<th scope="row" class="py-2 pr-3 font-normal text-muted-foreground">Наименование</th>
							<td class="py-2 pr-3">{company.legalName}</td>
							<td class="py-2">
								{record?.name ?? '—'}
								{#if check?.name_match === false}
									<span class="block text-warning">не совпадает с заявкой</span>
								{:else if check?.name_match === true}
									<span class="block text-success">совпадает</span>
								{/if}
							</td>
						</tr>
						<tr class="border-t">
							<th scope="row" class="py-2 pr-3 font-normal text-muted-foreground">ОГРН</th>
							<td class="py-2 pr-3 font-mono">{company.ogrn ?? '—'}</td>
							<td class="py-2 font-mono">
								{record?.ogrn ?? '—'}
								{#if record?.ogrn && company.ogrn && !same(record.ogrn, company.ogrn)}
									<span class="block font-sans text-warning">не совпадает</span>
								{/if}
							</td>
						</tr>
						<tr class="border-t">
							<th scope="row" class="py-2 pr-3 font-normal text-muted-foreground">КПП</th>
							<td class="py-2 pr-3 font-mono">{company.kpp ?? '—'}</td>
							<td class="py-2 font-mono">{record?.kpp ?? '—'}</td>
						</tr>
						{#if record}
							<tr class="border-t">
								<th scope="row" class="py-2 pr-3 font-normal text-muted-foreground">Руководитель</th>
								<td class="py-2 pr-3">—</td>
								<td class="py-2">{record.head ?? '—'}</td>
							</tr>
							<tr class="border-t">
								<th scope="row" class="py-2 pr-3 font-normal text-muted-foreground">Состояние</th>
								<td class="py-2 pr-3">—</td>
								<td class="py-2">
									{#if record.endedOn}
										<span class="text-destructive">прекратила деятельность {formatDate(record.endedOn)}</span>
									{:else}
										действует{record.registeredOn ? ` с ${formatDate(record.registeredOn)}` : ''}
									{/if}
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Полномочия заявителя</h2></Card.Title>
			</Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				<dl class="grid gap-2">
					<div>
						<dt class="text-muted-foreground">Заявитель</dt>
						<dd>
							{v.applicant.displayName ?? 'Без имени'}{v.applicant.memberStatus !== 'active' ? ' (не в команде)' : ''}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Способ подтверждения</dt>
						<dd class="font-medium" data-testid="authority-method">
							{AUTHORITY_METHODS[v.authorityMethod] ?? v.authorityMethod}
						</dd>
					</div>
					{#if v.authorityMethod === 'corporate_email_domain'}
						<div>
							<dt class="text-muted-foreground">Домен рабочей почты заявителя</dt>
							<dd class="font-mono" data-testid="applicant-domain">{data.applicantDomain ?? 'адрес удалён'}</dd>
							<dd class="mt-1 text-muted-foreground">
								Сверьте домен с официальным сайтом организации. Бесплатные почтовые сервисы полномочий не подтверждают.
							</dd>
						</div>
					{/if}
				</dl>
				<div class="rounded-lg border p-3" data-testid="evidence">
					{#if v.evidence}
						<a
							class="flex items-center gap-2 font-medium text-link underline-offset-4 hover:underline"
							href="{resolve('/(app)/operator/companies/requests/[id]/evidence', {
								id: v.verificationId
							})}?file={v.evidence.fileId}"
							data-testid="evidence-download"
						>
							<FileTextIcon class="size-4" aria-hidden="true" />
							{v.evidence.declaredName}
						</a>
						<p class="text-muted-foreground">{v.evidence.detectedMime}, {size(v.evidence.sizeBytes)}</p>
					{:else}
						<p class="text-muted-foreground">Документ не приложен: способ его не требует.</p>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Решение</h2></Card.Title>
				<Card.Description>
					Подана {formatDateTime(v.submittedAt)}.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-5 text-sm">
				{#if open}
					<DueStatus
						dueAt={data.dueAt}
						now={data.now}
						overdue={data.dueAt.getTime() <= data.now.getTime()}
						dueSoon={data.dueAt.getTime() - data.now.getTime() < 12 * 3_600_000}
					/>
					<form method="POST" action="?/approve" use:enhance class="grid gap-3" data-testid="approve-form">
						<CsrfInput />
						<p class="text-muted-foreground">
							Подтвердите реквизиты по реестру, если они отличаются от заявки; пустое поле оставит значение владельца.
						</p>
						<Field.Field data-invalid={fieldError('legalName') !== undefined}>
							<Field.Label for="approve-legal">Полное наименование</Field.Label>
							<Input id="approve-legal" name="legalName" placeholder={company.legalName} />
							{#if fieldError('legalName')}<Field.Error>{fieldError('legalName')}</Field.Error>{/if}
						</Field.Field>
						<div class="grid gap-3 sm:grid-cols-2">
							<Field.Field data-invalid={fieldError('ogrn') !== undefined}>
								<Field.Label for="approve-ogrn">ОГРН</Field.Label>
								<Input
									id="approve-ogrn"
									name="ogrn"
									inputmode="numeric"
									placeholder={company.ogrn ?? record?.ogrn ?? ''}
								/>
								{#if fieldError('ogrn')}<Field.Error>{fieldError('ogrn')}</Field.Error>{/if}
							</Field.Field>
							<Field.Field data-invalid={fieldError('kpp') !== undefined}>
								<Field.Label for="approve-kpp">КПП</Field.Label>
								<Input id="approve-kpp" name="kpp" placeholder={company.kpp ?? record?.kpp ?? ''} />
								{#if fieldError('kpp')}<Field.Error>{fieldError('kpp')}</Field.Error>{/if}
							</Field.Field>
						</div>
						<Button type="submit" class="justify-self-start">Подтвердить компанию</Button>
					</form>
					<form method="POST" use:enhance class="grid gap-3 border-t pt-4" data-testid="reject-form">
						<CsrfInput />
						<Field.Field data-invalid={fieldError('reason') !== undefined}>
							<Field.Label for="decision-reason">Сообщение владельцу</Field.Label>
							<Textarea id="decision-reason" name="reason" rows={4} minlength={10} maxlength={2000} required />
							<Field.Description>От 10 символов: что не так или что уточнить.</Field.Description>
							{#if fieldError('reason')}<Field.Error>{fieldError('reason')}</Field.Error>{/if}
						</Field.Field>
						<div class="flex flex-wrap gap-2">
							<Button type="submit" variant="outline" formaction="?/requestInfo">Запросить уточнение</Button>
							<Button type="submit" variant="destructive" formaction="?/reject">Отклонить</Button>
						</div>
					</form>
				{:else}
					{@const decision = v.state === 'pending' ? null : DECISIONS[v.state]}
					<p data-testid="decision" data-state={v.state}>
						{#if decision}
							<StatusPill label={decision.label} tone={decision.tone} />
						{:else}
							Решение по этой заявке больше не принимается: компания сменила статус.
						{/if}
					</p>
					<a
						class="text-link underline-offset-4 hover:underline"
						href={resolve('/(app)/operator/companies/[id]', { id: company.id })}>Карточка компании</a
					>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if v.history.length > 0}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Прошлые заявки</h2></Card.Title>
				</Card.Header>
				<Card.Content>
					<ol class="grid gap-3 text-sm">
						{#each v.history as item (item.verificationId)}
							{@const decision = item.decision ? DECISIONS[item.decision] : null}
							<li class="grid gap-1 border-b pb-3 last:border-0">
								<span class="flex flex-wrap items-center gap-2">
									{#if decision}<StatusPill label={decision.label} tone={decision.tone} />{:else}без решения{/if}
									{#if item.decidedAt}<span class="text-muted-foreground">{formatDateTime(item.decidedAt)}</span>{/if}
								</span>
								{#if item.reason}<p class="whitespace-pre-line">{item.reason}</p>{/if}
							</li>
						{/each}
					</ol>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>
