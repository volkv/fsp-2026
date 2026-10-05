<script lang="ts">
	import { resolve } from '$app/paths';
	import CandidateCard from '$lib/components/employer/candidate-card.svelte';
	import OfferForm from '$lib/components/employer/offer-form.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { InvitationStatus, RecommendationNotice } from '$lib/components/product/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form?.problem ?? null);
</script>

<PageHeader
	title={`Кандидат ${data.pseudonym}`}
	description="Псевдоним виден только вашей компании. Имя и контакты — после принятия предложения и только с согласия кандидата."
>
	{#snippet eyebrow()}
		<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/candidates')}>Кандидаты</a>
	{/snippet}
</PageHeader>

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<CandidateCard card={data.card} evidenceState={data.evidenceState} receipts={data.receipts} labels={data.labels} />
	<aside class="grid content-start gap-4">
		<RecommendationNotice compact />
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Предложить работу</h2></Card.Title>
				<Card.Description>
					Компания пишет первой: описание, вилка в рублях, способ связи и «почему вы». Вакансия — по желанию.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4">
				{#if problem}
					<FormMessage text={problem.message} />
				{/if}
				{#if data.invitation}
					<div class="flex flex-wrap items-center gap-2 text-sm" data-testid="existing-invitation">
						<InvitationStatus status={data.invitation.status} />
						<span class="text-muted-foreground">
							Предложение этому кандидату уже есть: новые условия — его новая версия.
						</span>
					</div>
					<a
						class={buttonVariants({ variant: 'outline' })}
						href={resolve('/(app)/company/(member)/invitations/[id]', { id: data.invitation.id })}
					>
						Открыть предложение
					</a>
				{:else if !data.offer.profileComplete}
					<p class="text-sm text-muted-foreground" data-testid="profile-incomplete">
						Кандидат увидит профиль компании в предложении. Заполните описание и направление деятельности в
						<a class="text-link underline" href={resolve('/company/profile')}>профиле компании</a>.
					</p>
				{:else}
					<OfferForm
						action="?/offer"
						vacancies={data.offer.vacancies}
						workFormats={data.offer.workFormats}
						whyYouOptions={data.whyYouOptions}
						responseWindowHours={data.offer.responseWindowHours}
						problems={problem?.fields ?? {}}
					/>
				{/if}
			</Card.Content>
		</Card.Root>
		{#if data.vacancies.length > 0}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Соответствие вакансиям</h2></Card.Title>
					<Card.Description>Разбор соответствия считается по требованиям конкретной вакансии.</Card.Description>
				</Card.Header>
				<Card.Content>
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
				</Card.Content>
			</Card.Root>
		{/if}
	</aside>
</div>
