<script lang="ts">
	import { resolve } from '$app/paths';
	import BabyIcon from '@lucide/svelte/icons/baby';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { ageText, RELATIONS, REPRESENTATION_STATUSES } from '$lib/components/operator/model.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Законные представители"
	description="Профиль кандидата 14–17 лет открывается только после того, как оператор проверит полномочия представителя. Подтверждённая почта доказывает лишь владение адресом."
/>

{#if data.queue.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><BabyIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Заявок нет</Empty.Title>
			<Empty.Description>Здесь появятся представители, подтвердившие почту.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<Card.Root>
		<Card.Content>
			<Table.Root label="Заявки представителей" data-testid="representation-queue">
				<Table.Header>
					<Table.Row>
						<Table.Head>Заявка</Table.Head>
						<Table.Head>Кем приходится</Table.Head>
						<Table.Head>Возраст кандидата</Table.Head>
						<Table.Head>Статус</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.queue as item (item.id)}
						{@const status = REPRESENTATION_STATUSES[item.status]}
						<Table.Row data-representation={item.id}>
							<Table.Cell>
								<a
									class="font-medium underline-offset-4 hover:underline"
									href={resolve('/(app)/operator/representatives/[id]', { id: item.id })}
								>
									почта подтверждена {item.contactConfirmedAt ? formatDateTime(item.contactConfirmedAt) : '—'}
								</a>
							</Table.Cell>
							<Table.Cell>{RELATIONS[item.relation] ?? item.relation}</Table.Cell>
							<Table.Cell>{ageText(item.age)}</Table.Cell>
							<Table.Cell
								>{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}</Table.Cell
							>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
{/if}
