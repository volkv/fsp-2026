<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { cellText, PARTNERSHIP_KINDS, POOL_AWARDS, POOL_STAGES, type Cell } from './model.js';

	interface Competition {
		ref: string;
		title: string;
		discipline: string;
		startDate: string | null;
		participants: Cell;
	}

	/**
	 * Opening a partnership of a verified company with an FSP competition: its basis (contract, regulations) and the
	 * pool rule. With `companies` the operator also picks the company; with `companyId` the company is fixed.
	 */
	let {
		competitions,
		companies = [],
		companyId = null,
		today,
		fields = {}
	}: {
		competitions: Competition[];
		companies?: { id: string; displayName: string; inn: string }[];
		companyId?: string | null;
		today: string;
		fields?: Record<string, string>;
	} = $props();
</script>

<form method="POST" action="?/openPartnership" use:enhance class="grid gap-4" data-testid="partnership-form">
	<CsrfInput />
	{#if companyId}
		<input type="hidden" name="companyId" value={companyId} />
	{:else}
		<Field.Field data-invalid={fields.companyId !== undefined}>
			<Field.Label for="partnership-company">Проверенная компания</Field.Label>
			<NativeSelect id="partnership-company" name="companyId" required>
				<option value="">Выберите компанию</option>
				{#each companies as company (company.id)}
					<option value={company.id}>{company.displayName} · ИНН {company.inn}</option>
				{/each}
			</NativeSelect>
			{#if fields.companyId}<Field.Error>{fields.companyId}</Field.Error>{/if}
		</Field.Field>
	{/if}
	<Field.Field data-invalid={fields.competitionRef !== undefined}>
		<Field.Label for="partnership-competition">Соревнование ФСП</Field.Label>
		<Input id="partnership-competition" name="competitionRef" list="partnership-competitions" required />
		<datalist id="partnership-competitions">
			{#each competitions as competition (competition.ref)}
				<option value={competition.ref}
					>{competition.title}{competition.startDate ? `, ${competition.startDate.slice(0, 4)}` : ''} — участников на платформе:
					{cellText(competition.participants)}</option
				>
			{/each}
		</datalist>
		<Field.Description
			>Идентификатор соревнования в источнике достижений ФСП; подсказки — соревнования с результатами на платформе.</Field.Description
		>
		{#if fields.competitionRef}<Field.Error>{fields.competitionRef}</Field.Error>{/if}
	</Field.Field>
	<div class="grid gap-4 sm:grid-cols-3">
		<Field.Field>
			<Field.Label for="partnership-kind">Вид партнёрства</Field.Label>
			<NativeSelect id="partnership-kind" name="kind" value="case_provider">
				{#each Object.entries(PARTNERSHIP_KINDS) as [key, label] (key)}
					<option value={key}>{label}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
		<Field.Field data-invalid={fields.poolRule !== undefined}>
			<Field.Label for="partnership-award">Кто входит в пул</Field.Label>
			<NativeSelect id="partnership-award" name="minAward" value="finalist">
				{#each Object.entries(POOL_AWARDS) as [key, label] (key)}
					<option value={key}>{label}</option>
				{/each}
			</NativeSelect>
			{#if fields.poolRule}<Field.Error>{fields.poolRule}</Field.Error>{/if}
		</Field.Field>
		<fieldset class="grid gap-1.5">
			<legend class="mb-1.5 text-sm font-medium">Этапы</legend>
			{#each Object.entries(POOL_STAGES) as [key, label] (key)}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="stages" value={key} checked={key === 'final'} class="size-4" />
					{label}
				</label>
			{/each}
		</fieldset>
	</div>
	<div class="grid gap-4 sm:grid-cols-2">
		<Field.Field data-invalid={fields.validFrom !== undefined}>
			<Field.Label for="partnership-from">Действует с</Field.Label>
			<Input id="partnership-from" name="validFrom" type="date" value={today} required />
			{#if fields.validFrom}<Field.Error>{fields.validFrom}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={fields.validTo !== undefined}>
			<Field.Label for="partnership-to">по (необязательно)</Field.Label>
			<Input id="partnership-to" name="validTo" type="date" />
			{#if fields.validTo}<Field.Error>{fields.validTo}</Field.Error>{/if}
		</Field.Field>
	</div>
	<Field.Field data-invalid={fields.basis !== undefined}>
		<Field.Label for="partnership-basis">Основание</Field.Label>
		<Textarea id="partnership-basis" name="basis" rows={2} required minlength={3} maxlength={1000} />
		<Field.Description>Договор или положение соревнования, на котором держится партнёрство.</Field.Description>
		{#if fields.basis}<Field.Error>{fields.basis}</Field.Error>{/if}
	</Field.Field>
	<p class="text-sm text-muted-foreground">
		В пул попадут только совершеннолетние участники с подходящим результатом, давшие согласие на передачу этому
		партнёру. Подростки 14–17 лет в пулы не входят.
	</p>
	<Button type="submit" class="justify-self-start">Открыть партнёрство</Button>
</form>
