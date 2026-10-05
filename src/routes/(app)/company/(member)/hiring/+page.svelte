<script lang="ts">
	import { resolve } from '$app/paths';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import { hiringView } from '$lib/components/employer/model.js';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { HiringStages } from '$lib/components/product/index.js';
	import { formatDate } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Найм"
	description="Процессы найма после принятых приглашений: этапы и исход отмечает каждая сторона сама, расхождения видны обеим."
/>

{#if data.processes.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><ListChecksIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Процессов найма пока нет</Empty.Title>
			<Empty.Description>Процесс открывается, когда кандидат принимает приглашение.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-4">
		{#each data.processes as item (item.process.id)}
			<li>
				<Card.Root data-process={item.process.id}>
					<Card.Header>
						<Card.Title>
							<h2 class="font-heading text-h3">
								<a
									class="hover:underline"
									href={resolve('/(app)/company/(member)/invitations/[id]', { id: item.invitationId })}
								>
									{item.pseudonym} · {item.title}
								</a>
							</h2>
						</Card.Title>
						<Card.Description>
							Открыт {formatDate(item.process.openedAt)} · исход ожидается до {formatDate(item.process.outcomeDueAt)}
						</Card.Description>
					</Card.Header>
					<Card.Content>
						<HiringStages hiring={hiringView(item.process.outcome, item.process.reports)} />
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>
{/if}
