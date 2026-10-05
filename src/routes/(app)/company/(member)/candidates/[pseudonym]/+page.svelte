<script lang="ts">
	import { resolve } from '$app/paths';
	import CandidateCard from '$lib/components/employer/candidate-card.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { RecommendationNotice } from '$lib/components/product/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title={`Кандидат ${data.pseudonym}`}
	description="Псевдоним виден только вашей компании. Имя и контакты — после принятия приглашения и только с согласия кандидата."
>
	{#snippet eyebrow()}
		<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/candidates')}>Кандидаты</a>
	{/snippet}
</PageHeader>

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<CandidateCard card={data.card} evidenceState={data.evidenceState} receipts={data.receipts} labels={data.labels} />
	<aside class="grid content-start gap-4 lg:sticky lg:top-20 lg:self-start">
		<RecommendationNotice compact />
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Почему подходит и приглашение</h2></Card.Title>
				<Card.Description>
					Соответствие считается по требованиям конкретной вакансии, приглашение отправляется на неё же.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if data.vacancies.length === 0}
					<p class="text-sm text-muted-foreground">
						У компании нет открытых вакансий. <a class="text-link underline" href={resolve('/company/vacancies/new')}
							>Создайте вакансию</a
						>.
					</p>
				{:else}
					<ul class="grid gap-2">
						{#each data.vacancies as vacancy (vacancy.id)}
							<li>
								<a
									class="text-sm font-medium text-link underline-offset-4 hover:underline"
									href={resolve('/(app)/company/(member)/vacancies/[id]/candidates/[pseudonym]', {
										id: vacancy.id,
										pseudonym: data.pseudonym
									})}
									data-sveltekit-preload-data="tap"
								>
									{vacancy.title}
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>
	</aside>
</div>
