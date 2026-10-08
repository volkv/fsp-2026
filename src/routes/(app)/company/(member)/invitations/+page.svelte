<script lang="ts">
	import { candidateLabel } from '$lib/text/candidate-label';
	import { resolve } from '$app/paths';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { InvitationStatus, ResponseDeadline, SalaryRange } from '$lib/components/product/index.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Приглашения"
	description="Предложения работы кандидатам: статус, текущая версия условий и срок ответа. Отправленные условия не меняются — пересмотр создаёт новую версию."
/>

{#if data.invitations.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><InboxIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Приглашений пока нет</Empty.Title>
			<Empty.Description
				>Откройте карточку кандидата в каталоге и предложите работу — с вилкой в рублях и «почему вы».</Empty.Description
			>
		</Empty.Header>
	</Empty.Root>
{:else}
	<div class="overflow-x-auto rounded-xl border">
		<Table.Root label="Приглашения">
			<Table.Header>
				<Table.Row>
					<Table.Head>Кандидат</Table.Head>
					<Table.Head>Предложение</Table.Head>
					<Table.Head>Условия</Table.Head>
					<Table.Head>Статус</Table.Head>
					<Table.Head>Отправлено</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.invitations as invitation (invitation.id)}
					<Table.Row data-invitation={invitation.id}>
						<Table.Cell>
							<a
								class="font-medium text-link underline-offset-4 hover:underline"
								href={resolve('/(app)/company/(member)/invitations/[id]', { id: invitation.id })}
							>
								{candidateLabel(invitation.candidatePseudonym)}
							</a>
						</Table.Cell>
						<Table.Cell>
							<span class="font-medium">{invitation.title}</span>
							<span class="block text-xs text-muted-foreground">
								{invitation.vacancyTitle ? `Вакансия «${invitation.vacancyTitle}»` : 'Без вакансии'}
							</span>
						</Table.Cell>
						<Table.Cell>
							<SalaryRange salary={invitation.salary} />
							<span class="text-xs text-muted-foreground">версия {invitation.version}</span>
						</Table.Cell>
						<Table.Cell>
							<div class="grid justify-items-start gap-1">
								<InvitationStatus status={invitation.status} />
								{#if invitation.awaitingRepresentative}
									<StatusPill label="Принято, ждём согласия представителя" tone="warning" />
								{/if}
								{#if invitation.status === 'sent' || invitation.status === 'viewed'}
									<ResponseDeadline dueAt={invitation.responseDueAt} />
								{/if}
							</div>
						</Table.Cell>
						<Table.Cell class="text-muted-foreground">{formatDateTime(invitation.sentAt)}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
{/if}
