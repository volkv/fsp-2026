<script lang="ts">
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import CountCell from '$lib/components/operator/count-cell.svelte';
	import { disciplineName } from '$lib/components/employer/model.js';
	import PartnershipForm from '$lib/components/operator/partnership-form.svelte';
	import PartnershipList from '$lib/components/operator/partnership-list.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const done = $derived(
		form && 'done' in form
			? form.done === 'opened'
				? 'Партнёрство открыто.'
				: 'Партнёрство завершено: пул закрыт.'
			: null
	);
	const titles = $derived(Object.fromEntries(data.competitions.map((c) => [c.ref, c.title])));
</script>

<PageHeader
	title="Партнёрства с соревнованиями"
	description="Кейсодатели и спонсоры соревнований ФСП получают пул участников — только совершеннолетних и только по их согласию на передачу этому партнёру."
/>

{#if problem}
	<FormProblem text={problem.message} />
{:else if done}
	<FormProblem tone="success" text={done} />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<section aria-labelledby="partnerships-heading" class="grid content-start gap-4">
		<h2 id="partnerships-heading" class="font-heading text-h3">Партнёрства</h2>
		{#if data.partnerships.length === 0}
			<Empty.Root class="border">
				<Empty.Header>
					<Empty.Media variant="icon"><HandshakeIcon aria-hidden="true" /></Empty.Media>
					<Empty.Title>Партнёрств пока нет</Empty.Title>
					<Empty.Description>Откройте первое: проверенная компания, соревнование и основание.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<PartnershipList partnerships={data.partnerships} competitionTitles={titles} />
		{/if}

		<h2 class="mt-4 font-heading text-h3">Соревнования с результатами на платформе</h2>
		{#if data.competitions.length === 0}
			<p class="text-sm text-muted-foreground">Результатов ФСП на платформе пока нет.</p>
		{:else}
			<Card.Root>
				<Card.Content>
					<Table.Root label="Соревнования с результатами на платформе">
						<Table.Header>
							<Table.Row>
								<Table.Head>Соревнование</Table.Head>
								<Table.Head>Дисциплина</Table.Head>
								<Table.Head class="text-right">Участников</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.competitions as competition (competition.ref)}
								<Table.Row>
									<Table.Cell>
										{competition.title}
										<span class="block font-mono text-xs text-muted-foreground">{competition.ref}</span>
									</Table.Cell>
									<Table.Cell>{disciplineName(competition.discipline)}</Table.Cell>
									<Table.Cell class="text-right"><CountCell cell={competition.participants} /></Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Card.Content>
			</Card.Root>
		{/if}
	</section>

	<Card.Root class="self-start">
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Открыть партнёрство</h2></Card.Title>
			<Card.Description>Правило пула по умолчанию — финалисты финала.</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.companies.length === 0}
				<p class="text-sm text-muted-foreground">Проверенных компаний нет: партнёром может стать только проверенная.</p>
			{:else}
				<PartnershipForm
					competitions={data.competitions}
					companies={data.companies}
					today={data.today}
					fields={problem?.fields ?? {}}
				/>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
