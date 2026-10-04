<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import {
		ageText,
		AUTHORITY_BASES,
		AUTHORITY_CHECK_METHODS,
		END_REASONS,
		RELATIONS,
		REPRESENTATION_STATUSES
	} from '$lib/components/operator/model.js';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const r = $derived(data.representation);
	const status = $derived(REPRESENTATION_STATUSES[r.status]);
	const awaiting = $derived(r.status === 'contact_confirmed' || r.status === 'authority_pending');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];
	const DECIDED: Record<string, string> = {
		verified: 'Полномочия подтверждены: профиль подростка открыт в защищённом режиме.',
		rejected: 'Полномочия не подтверждены: связь завершена, профиль остаётся закрытым.'
	};
	const PRECISION: Record<string, string> = { day: '', month: ' (месяц и год)', year: ' (только год)' };
	const BIRTH_STATUS: Record<string, string> = {
		unverified: 'со слов кандидата',
		verified: 'подтверждена',
		conflict: 'источники расходятся'
	};
	const birth = $derived(
		r.candidate.birthDate
			? `${formatDate(r.candidate.birthDate)}${PRECISION[r.candidate.birthDatePrecision ?? 'day'] ?? ''}`
			: 'не указана'
	);
</script>

<PageHeader
	title="Проверка полномочий представителя"
	description="Ч. 1 ст. 9 152-ФЗ: согласие за подростка даёт законный представитель."
>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/representatives')}>Представители</a>
	{/snippet}
	{#snippet actions()}
		{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormProblem text={problem.message} />
{:else if data.decided && DECIDED[data.decided]}
	<FormProblem tone="success" text={DECIDED[data.decided] ?? ''} />
{/if}

<div class="grid gap-6 lg:grid-cols-2" data-representation={r.id} data-status={r.status}>
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Представитель</h2></Card.Title>
				<Card.Description>Данные открыты на время дела; открытие записано в журнал.</Card.Description>
			</Card.Header>
			<Card.Content>
				<dl class="grid gap-3 text-sm">
					<div>
						<dt class="text-muted-foreground">ФИО</dt>
						<dd class="font-medium">{r.representative.fullName}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Кем приходится</dt>
						<dd>{RELATIONS[r.relation] ?? r.relation}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Почта</dt>
						<dd>{r.representative.email}</dd>
					</div>
					{#if r.representative.phone}
						<div>
							<dt class="text-muted-foreground">Телефон</dt>
							<dd>{r.representative.phone}</dd>
						</div>
					{/if}
					<div>
						<dt class="text-muted-foreground">Почта подтверждена</dt>
						<dd>{r.contactConfirmedAt ? formatDateTime(r.contactConfirmedAt) : 'нет'}</dd>
					</div>
					{#if r.endedAt}
						<div>
							<dt class="text-muted-foreground">Связь завершена</dt>
							<dd>{formatDateTime(r.endedAt)}{r.endReason ? `: ${END_REASONS[r.endReason] ?? r.endReason}` : ''}</dd>
						</div>
					{/if}
				</dl>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Кандидат</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				<dl class="grid gap-3 text-sm">
					<div>
						<dt class="text-muted-foreground">Имя в профиле</dt>
						<dd>{r.candidate.displayName ?? 'не указано'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Дата рождения</dt>
						<dd>{birth}, {BIRTH_STATUS[r.candidate.birthDateStatus] ?? r.candidate.birthDateStatus}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Возраст</dt>
						<dd data-testid="candidate-age">{ageText(r.candidate.age)}</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Решение</h2></Card.Title>
				<Card.Description>
					Сверьте документ с представителем и запишите способ и минимальное основание. Копия документа — не единственный
					путь: встреча или видеозвонок так же действительны, и копия тогда не хранится.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if !awaiting}
					<p class="text-sm text-muted-foreground">Решение по этой связи уже принято.</p>
				{:else if r.methods.length === 0}
					<p class="text-sm text-warning">
						Действующая политика не разрешает работу с подростками или способы проверки без копии документа.
					</p>
				{:else}
					<form method="POST" use:enhance class="grid gap-4" data-testid="authority-form">
						<CsrfInput />
						<fieldset class="grid gap-2" aria-describedby="method-error">
							<legend class="mb-1 text-sm font-medium">Способ проверки</legend>
							{#each r.methods as method, index (method)}
								{@const meta = AUTHORITY_CHECK_METHODS[method]}
								<label class="flex items-start gap-2 text-sm">
									<input type="radio" name="method" value={method} checked={index === 0} class="mt-0.5 size-4" />
									<span>
										<span class="font-medium">{meta?.label ?? method}</span>
										{#if meta}<span class="block text-muted-foreground">{meta.hint}</span>{/if}
									</span>
								</label>
							{/each}
							{#if fieldError('method')}<p id="method-error" class="text-sm text-destructive">
									{fieldError('method')}
								</p>{/if}
						</fieldset>
						<Field.Field data-invalid={fieldError('basisKind') !== undefined}>
							<Field.Label for="basis-kind">Минимальное основание</Field.Label>
							<NativeSelect id="basis-kind" name="basisKind" required>
								<option value="">Выберите документ</option>
								{#each data.bases as basis (basis)}
									<option value={basis}>{AUTHORITY_BASES[basis] ?? basis}</option>
								{/each}
							</NativeSelect>
							{#if fieldError('basisKind')}<Field.Error>{fieldError('basisKind')}</Field.Error>{/if}
						</Field.Field>
						<Field.Field data-invalid={fieldError('basisNote') !== undefined}>
							<Field.Label for="basis-note">Что сверено</Field.Label>
							<Textarea id="basis-note" name="basisNote" rows={2} maxlength={500} />
							<Field.Description
								>Без номеров и реквизитов документа: «ФИО родителя совпадает, ребёнок указан в свидетельстве».</Field.Description
							>
							{#if fieldError('basisNote')}<Field.Error>{fieldError('basisNote')}</Field.Error>{/if}
						</Field.Field>
						<Field.Field data-invalid={fieldError('note') !== undefined}>
							<Field.Label for="authority-note">Заметка (обязательна при отказе)</Field.Label>
							<Textarea id="authority-note" name="note" rows={2} maxlength={500} />
							{#if fieldError('note')}<Field.Error>{fieldError('note')}</Field.Error>{/if}
						</Field.Field>
						<div class="flex flex-wrap gap-2">
							<Button type="submit" formaction="?/verify">Подтвердить полномочия</Button>
							<Button type="submit" variant="destructive" formaction="?/reject">Отказать</Button>
						</div>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if r.checks.length > 0}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Проверки</h2></Card.Title>
				</Card.Header>
				<Card.Content>
					<ol class="grid gap-3 text-sm">
						{#each r.checks as check (check.checkedAt.toISOString())}
							<li class="grid gap-1 border-b pb-3 last:border-0">
								<span class="flex flex-wrap items-center gap-2">
									<StatusPill
										label={check.result === 'verified' ? 'Подтверждено' : 'Отказано'}
										tone={check.result === 'verified' ? 'success' : 'danger'}
									/>
									<span class="text-muted-foreground"
										>{formatDateTime(check.checkedAt)}, {check.checkedByName ?? 'оператор'}</span
									>
								</span>
								<span>
									{AUTHORITY_CHECK_METHODS[check.method]?.label ?? check.method} · {AUTHORITY_BASES[check.basisKind] ??
										check.basisKind}
								</span>
								{#if check.basisNote}<span class="text-muted-foreground">{check.basisNote}</span>{/if}
								{#if check.note}<span class="text-muted-foreground">{check.note}</span>{/if}
								{#if check.evidence}
									<a
										class="text-link underline-offset-4 hover:underline"
										href="{resolve('/(app)/operator/representatives/[id]/evidence', {
											id: r.id
										})}?file={check.evidence.fileId}"
										data-testid="authority-evidence"
									>
										Копия документа: {check.evidence.declaredName}
									</a>
								{/if}
							</li>
						{/each}
					</ol>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>
