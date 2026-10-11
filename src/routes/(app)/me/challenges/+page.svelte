<script lang="ts">
	import FastForwardIcon from '@lucide/svelte/icons/fast-forward';
	import SwordsIcon from '@lucide/svelte/icons/swords';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const STATUS = {
		delivered: { label: 'Новый', tone: 'info' },
		opened: { label: 'Открыт', tone: 'neutral' },
		solved: { label: 'Решение отправлено', tone: 'success' },
		dismissed: { label: 'Не интересно', tone: 'neutral' },
		expired: { label: 'Срок прошёл', tone: 'neutral' }
	} as const;

	const problem = $derived(form && 'problem' in form ? form.problem : null);
</script>

<PageHeader
	title="Задания компаний"
	description="Короткие задачи компаний с видимой вилкой и целью. Решение или подход компания видит без вашего имени и может пригласить по нему; отправленное решение освежает профиль в выдаче."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
	{#snippet actions()}
		{#if data.demoClockSeconds !== null}
			<form method="POST" action="?/advanceClock" use:enhance>
				<CsrfInput />
				<Button type="submit" variant="outline" size="sm" data-testid="advance-clock">
					<FastForwardIcon aria-hidden="true" />
					Промотать неделю
				</Button>
			</form>
		{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'advanced' in form}
	<FormMessage
		tone="success"
		text={`Часы демо-сессии ушли на неделю вперёд: новых доставок — ${form.advanced}, неоткрытым ушло напоминание.`}
	/>
{/if}
{#if data.demoClockSeconds !== null && data.demoClockSeconds > 0}
	<p class="text-sm text-muted-foreground" data-testid="demo-clock">
		Часы демо-сессии впереди на {Math.round(data.demoClockSeconds / 86_400)} дн.
	</p>
{/if}

{#if data.deliveries.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><SwordsIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Заданий пока нет</Empty.Title>
			<Empty.Description>
				Задание приходит кандидатам категорий, на которые оно рассчитано, не чаще раза в неделю. Категория подтверждается
				тестом.
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/category')}>Категория и грейд</a>
		</Empty.Content>
	</Empty.Root>
{:else}
	<ul class="grid gap-3" data-testid="challenge-list">
		{#each data.deliveries as item (item.deliveryId)}
			<li>
				<a
					href={resolve('/(app)/me/challenges/[deliveryId]', { deliveryId: item.deliveryId })}
					class="grid gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
					data-delivery-status={item.status}
				>
					<span class="grid gap-1">
						<span class="font-heading text-lg">{item.challenge.title}</span>
						<span class="text-sm text-muted-foreground">
							{item.challenge.companyName} · {data.names.specializations[item.challenge.specialization]} · до {formatDate(
								item.challenge.endsAt
							)}
						</span>
						<SalaryRange
							salary={{
								min: item.challenge.salary.min,
								max: item.challenge.salary.max,
								currency: 'RUB',
								period: 'month',
								taxBase: item.challenge.salary.taxBase
							}}
						/>
					</span>
					<span class="flex flex-wrap items-center gap-2 sm:justify-end">
						<StatusPill label={STATUS[item.status].label} tone={STATUS[item.status].tone} />
						{#if item.solution?.decision === 'invited'}
							<StatusPill label="Компания пригласила" tone="success" />
						{/if}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
