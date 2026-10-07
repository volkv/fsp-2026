<script lang="ts">
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { InvitationStatus, ResponseDeadline, SalaryRange } from '$lib/components/product/index.js';
	import { formatDate } from '$lib/components/product/model.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const open = (status: string) => status === 'sent' || status === 'viewed';

	const OUTCOME_STATES = {
		pending: { label: 'Найм: исход ожидается', tone: 'neutral' },
		single_party: { label: 'Найм: исход отмечен одной стороной', tone: 'info' },
		confirmed: { label: 'Найм: исход подтверждён', tone: 'success' },
		diverged: { label: 'Найм: стороны отметили по-разному', tone: 'warning' },
		unknown: { label: 'Найм: исход неизвестен', tone: 'neutral' }
	} as const;
</script>

<PageHeader
	title="Приглашения"
	description="Работодатель выходит на вас сам — с описанием, вилкой в рублях, «почему вы» и сроком ответа. Условия отправленного приглашения не меняются: пересмотр приходит новой версией."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

{#if data.invitations.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><InboxIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Приглашений пока нет</Empty.Title>
			<Empty.Description>
				Проверьте, что профиль показывается в каталоге, а статус поиска — «Активно ищу» или «Открыт к предложениям».
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/visibility')}>Видимость и согласия</a
			>
		</Empty.Content>
	</Empty.Root>
{:else}
	<ul class="grid gap-3" data-testid="invitation-list">
		{#each data.invitations as item (item.id)}
			<li>
				<a
					href={resolve('/(app)/me/invitations/[id]', { id: item.id })}
					class="grid gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
					data-invitation-status={item.status}
				>
					<span class="grid gap-1">
						<span class="font-heading text-lg">{item.title}</span>
						<span class="text-sm text-muted-foreground">
							{item.companyName}{item.companyVerification === 'verified' ? '' : ' · компания не проверена'} · отправлено {formatDate(
								item.sentAt
							)}{item.version > 1 ? ` · версия ${item.version}` : ''}
						</span>
						<SalaryRange salary={item.salary} />
					</span>
					<span class="flex flex-wrap items-center gap-2 sm:justify-end">
						<InvitationStatus status={item.status} />
						{#if item.awaitingRepresentative}
							<StatusPill label="Ждём согласия представителя" tone="warning" />
						{/if}
						{#if open(item.status)}
							<ResponseDeadline dueAt={item.responseDueAt} />
						{/if}
						{#if item.hiring}
							<StatusPill
								label={OUTCOME_STATES[item.hiring.outcome].label}
								tone={OUTCOME_STATES[item.hiring.outcome].tone}
							/>
						{/if}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
