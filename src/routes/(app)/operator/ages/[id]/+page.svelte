<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { REPRESENTATION_STATUSES } from '$lib/components/operator/model.js';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const c = $derived(data.ageCase);
	const open = $derived(c.status === 'conflict');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];

	const METHODS: Record<string, { label: string; hint: string }> = {
		document_presented: {
			label: 'Документ на встрече или видеозвонке',
			hint: 'Вы видите документ и человека одновременно; копия не хранится.'
		},
		in_person: { label: 'Личный визит', hint: 'Человек пришёл с документом; копия не хранится.' }
	};
	const DOCUMENTS: Record<string, string> = {
		passport: 'Паспорт гражданина РФ',
		birth_certificate: 'Свидетельство о рождении',
		international_passport: 'Заграничный паспорт',
		foreign_identity_document: 'Документ иностранного гражданина'
	};
	const SOURCES: Record<string, string> = {
		self_declared: 'указал кандидат',
		fsp_import: 'из ФСП',
		operator_document: 'по документу'
	};
	const DECIDED: Record<string, string> = {
		adult: 'Дата подтверждена: кандидату 18 или больше, профиль открыт во взрослом режиме.',
		minor:
			'Дата подтверждена: кандидату 14–17 лет, профиль работает в защищённом режиме — согласия нужны и от законного представителя.'
	};
	const declared = $derived(
		c.declared.birthDate
			? c.declared.precision === 'year'
				? `${c.declared.birthDate.slice(0, 4)} год`
				: formatDate(c.declared.birthDate)
			: 'не указана'
	);
	const representation = $derived(c.representation ? REPRESENTATION_STATUSES[c.representation.status] : null);
</script>

<PageHeader
	title="Дата рождения: расхождение источников"
	description="Возраст определяет режим профиля: пока даты расходятся, профиль закрыт. Сверьте документ с человеком и запишите дату из документа."
>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/ages')}>Конфликты возраста</a>
	{/snippet}
	{#snippet actions()}
		<StatusPill label={open ? 'Ждёт решения' : 'Решено'} tone={open ? 'warning' : 'success'} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormProblem text={problem.message} />
{:else if data.decided && DECIDED[data.decided]}
	<FormProblem tone="success" text={DECIDED[data.decided] ?? ''} />
	{#if data.hidden}
		<p class="text-sm text-muted-foreground" data-testid="age-hidden">
			Профиль снят с показа в каталоге до подтверждения законного представителя.
		</p>
	{/if}
{/if}

<div class="grid gap-6 lg:grid-cols-2" data-age-case={c.candidateId} data-status={c.status}>
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Кандидат</h2></Card.Title>
				<Card.Description
					>ФИО и почта открыты на время дела, чтобы договориться о проверке и сверить документ; открытие записано в
					журнал.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<dl class="grid gap-3 text-sm">
					<div>
						<dt class="text-muted-foreground">ФИО</dt>
						<dd class="font-medium">{c.person.fullName ?? c.person.displayName ?? 'не указано'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Почта</dt>
						<dd>{c.person.email ?? '—'}</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Что расходится</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				<dl class="grid gap-3 text-sm">
					<div>
						<dt class="text-muted-foreground">Дата в профиле</dt>
						<dd data-testid="declared-date">
							{declared}{c.declared.source ? `, ${SOURCES[c.declared.source] ?? c.declared.source}` : ''}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Источник расхождения</dt>
						<dd>
							Результаты ФСП: год рождения спортсмена не совпал с датой в профиле{c.openedAt
								? ` (${formatDateTime(c.openedAt)})`
								: ''}.
							{#if c.fspAthleteId}
								<span class="block text-muted-foreground">Спортсмен в реестре ФСП: {c.fspAthleteId}</span>
							{/if}
						</dd>
					</div>
					{#if c.verifiedAt}
						<div>
							<dt class="text-muted-foreground">Подтверждено</dt>
							<dd>{formatDateTime(c.verifiedAt)}</dd>
						</div>
					{/if}
					<div>
						<dt class="text-muted-foreground">Законный представитель</dt>
						<dd>
							{#if representation}<StatusPill label={representation.label} tone={representation.tone} />{:else}не указан{/if}
						</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root class="content-start">
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Решение</h2></Card.Title>
			<Card.Description>
				18 лет и старше — взрослый режим. 14–17 лет — защищённый режим: согласия подписывает и законный представитель,
				без подтверждённого представителя профиль уходит из каталога. Младше 14 лет{c.minorsAllowed
					? ''
					: ' (и 14–17, пока работа с несовершеннолетними выключена)'} профиль вести нельзя — такое решение здесь не записывается.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if !open}
				<p class="text-sm text-muted-foreground">Расхождения больше нет: дата подтверждена.</p>
			{:else}
				<form method="POST" action="?/decide" use:enhance class="grid gap-4" data-testid="age-form">
					<CsrfInput />
					<Field.Field data-invalid={fieldError('birthDate') !== undefined}>
						<Field.Label for="birth-date">Дата рождения по документу</Field.Label>
						<Input
							id="birth-date"
							name="birthDate"
							type="date"
							required
							value={c.declared.precision === 'day' ? (c.declared.birthDate ?? '') : ''}
						/>
						{#if fieldError('birthDate')}<Field.Error>{fieldError('birthDate')}</Field.Error>{/if}
					</Field.Field>
					<fieldset class="grid gap-2" aria-describedby="method-error">
						<legend class="mb-1 text-sm font-medium">Способ проверки</legend>
						{#each data.methods as method, index (method)}
							{@const meta = METHODS[method]}
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
					<Field.Field data-invalid={fieldError('documentKind') !== undefined}>
						<Field.Label for="document-kind">Документ</Field.Label>
						<NativeSelect id="document-kind" name="documentKind" required>
							<option value="">Выберите документ</option>
							{#each data.documents as kind (kind)}
								<option value={kind}>{DOCUMENTS[kind] ?? kind}</option>
							{/each}
						</NativeSelect>
						<Field.Description>Номер и реквизиты документа не записываются.</Field.Description>
						{#if fieldError('documentKind')}<Field.Error>{fieldError('documentKind')}</Field.Error>{/if}
					</Field.Field>
					<div>
						<Button type="submit">Подтвердить дату</Button>
					</div>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
