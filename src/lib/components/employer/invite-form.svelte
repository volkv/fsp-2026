<script lang="ts">
	import { enhance } from '$app/forms';
	import SendIcon from '@lucide/svelte/icons/send';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { SALARY_PERIODS, TAX_BASES, pluralize } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';

	/**
	 * Terms of an invitation version (domain 13.5): the range in the currency, period and tax base of the vacancy — they
	 * are copied, not chosen — with the lower bound not below the vacancy range; the response deadline comes from the
	 * invitation policy. Sent terms never change: a revision is a new version.
	 */
	interface Props {
		action: string;
		salary: {
			min: number;
			max: number;
			currency: string;
			period: 'month' | 'year' | 'hour' | 'project';
			taxBase: 'gross' | 'net';
		};
		/** The offer to start from; the vacancy range by default. */
		initial?: { min: number; max: number; message: string | null };
		responseWindowHours: number | null;
		/** Field problems by the path of the service (`salary_min`, `salary_max`, `message`). */
		problems?: Record<string, string>;
		submitLabel?: string;
	}

	let { action, salary, initial, responseWindowHours, problems = {}, submitLabel = 'Пригласить' }: Props = $props();

	const id = $props.id();
	const currency = $derived(
		new Intl.NumberFormat('ru-RU', { style: 'currency', currency: salary.currency, maximumFractionDigits: 0 })
			.formatToParts(0)
			.find((part) => part.type === 'currency')?.value ?? salary.currency
	);
	const responseWindow = $derived.by(() => {
		if (responseWindowHours === null) return null;
		if (responseWindowHours % 24 === 0) {
			const days = responseWindowHours / 24;
			return `${days} ${pluralize(days, ['день', 'дня', 'дней'])}`;
		}
		return `${responseWindowHours} ч`;
	});
</script>

<form method="POST" {action} use:enhance class="grid gap-4" data-testid="invite-form">
	<CsrfInput />
	<div class="grid gap-1 text-sm">
		<span class="text-muted-foreground">Вилка вакансии</span>
		<SalaryRange {salary} />
	</div>
	<div class="grid gap-3 sm:grid-cols-2">
		<Field.Field data-invalid={problems.salary_min !== undefined}>
			<Field.Label for="{id}-min">От, {currency}</Field.Label>
			<Input
				id="{id}-min"
				name="salaryMin"
				inputmode="numeric"
				value={String(initial?.min ?? salary.min)}
				aria-describedby="{id}-unit"
				required
			/>
			{#if problems.salary_min}<Field.Error>{problems.salary_min}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={problems.salary_max !== undefined}>
			<Field.Label for="{id}-max">До, {currency}</Field.Label>
			<Input
				id="{id}-max"
				name="salaryMax"
				inputmode="numeric"
				value={String(initial?.max ?? salary.max)}
				aria-describedby="{id}-unit"
				required
			/>
			{#if problems.salary_max}<Field.Error>{problems.salary_max}</Field.Error>{/if}
		</Field.Field>
	</div>
	<p id="{id}-unit" class="text-xs text-muted-foreground">
		{SALARY_PERIODS[salary.period]}, {TAX_BASES[salary.taxBase]} — как в вакансии. Нижняя граница не ниже вилки вакансии.
	</p>
	<Field.Field data-invalid={problems.message !== undefined}>
		<Field.Label for="{id}-message">Сообщение кандидату (необязательно)</Field.Label>
		<Textarea id="{id}-message" name="message" rows={4} maxlength={4000} value={initial?.message ?? ''} />
		{#if problems.message}<Field.Error>{problems.message}</Field.Error>{/if}
	</Field.Field>
	{#if responseWindow}
		<p class="text-sm">Срок ответа — <span class="font-medium">{responseWindow}</span> с момента отправки.</p>
	{/if}
	<Button type="submit" class="justify-self-start">
		<SendIcon aria-hidden="true" />
		{submitLabel}
	</Button>
</form>
