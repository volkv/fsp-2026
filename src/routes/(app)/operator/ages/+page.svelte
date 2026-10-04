<script lang="ts">
	import { resolve } from '$app/paths';
	import CalendarXIcon from '@lucide/svelte/icons/calendar-x';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const PRECISION: Record<string, string> = { day: 'точная дата', year: 'только год' };
</script>

<PageHeader
	title="Конфликты возраста"
	description="Год рождения из ФСП не совпал с датой, которую указал кандидат. Пока оператор не сверит документ, возраст не подтверждён и профиль закрыт."
/>

{#if data.queue.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><CalendarXIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Расхождений нет</Empty.Title>
			<Empty.Description>Здесь появятся профили, где даты рождения из разных источников не совпали.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<Card.Root>
		<Card.Content>
			<Table.Root label="Конфликты даты рождения" data-testid="age-queue">
				<Table.Header>
					<Table.Row>
						<Table.Head>Дело</Table.Head>
						<Table.Head>Указанная дата</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.queue as item (item.candidateId)}
						<Table.Row data-age-case={item.candidateId}>
							<Table.Cell>
								<a
									class="font-medium underline-offset-4 hover:underline"
									href={resolve('/(app)/operator/ages/[id]', { id: item.candidateId })}
								>
									{item.openedAt ? `расхождение от ${formatDateTime(item.openedAt)}` : 'расхождение'}
								</a>
							</Table.Cell>
							<Table.Cell>{item.declaredPrecision ? PRECISION[item.declaredPrecision] : 'не указана'}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
{/if}
