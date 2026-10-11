<script lang="ts">
	import { candidateLabel } from '$lib/text/candidate-label';
	import { resolve } from '$app/paths';
	import CandidateCard from '$lib/components/employer/candidate-card.svelte';
	import OfferForm from '$lib/components/employer/offer-form.svelte';
	import { matchView } from '$lib/components/employer/model.js';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { InvitationStatus, MatchBreakdown, RecommendationNotice } from '$lib/components/product/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form?.problem ?? null);
	const match = $derived(data.match ? matchView(data.match, data.labels) : null);
	const vacancySalary = $derived(
		data.vacancy.salary.currency === 'RUB' && data.vacancy.salary.period === 'month' ? data.vacancy.salary : null
	);
</script>

<PageHeader
	title={candidateLabel(data.pseudonym)}
	description="Псевдоним виден только вашей компании. Имя и контакты — после принятия предложения и только с согласия кандидата."
>
	{#snippet eyebrow()}
		<a
			class="text-link underline-offset-4 hover:underline"
			href={resolve('/(app)/company/(member)/vacancies/[id]/candidates', { id: data.vacancy.id })}
			>Кандидаты под «{data.vacancy.title}»</a
		>
	{/snippet}
</PageHeader>

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid content-start gap-6">
		{#if match}
			<Card.Root data-tour="vacancy-match">
				<Card.Content>
					<MatchBreakdown {match} />
				</Card.Content>
			</Card.Root>
		{/if}
		<CandidateCard
			card={data.card}
			evidenceState={data.evidenceState}
			receipts={data.receipts}
			labels={data.labels}
			signals={data.signals}
		/>
	</div>

	<aside class="grid content-start gap-4 lg:sticky lg:top-20 lg:self-start">
		<RecommendationNotice compact />
		<Card.Root data-tour="vacancy-offer">
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Предложить работу</h2></Card.Title>
				<Card.Description>
					С вакансией «{data.vacancy.title}» — или без неё: вакансия в предложении по желанию.
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
						action="?/invite"
						vacancies={data.offer.vacancies}
						workFormats={data.offer.workFormats}
						whyYouOptions={data.whyYouOptions}
						initial={{
							title: data.vacancy.title,
							description: data.vacancy.description,
							salaryMin: vacancySalary?.min ?? null,
							salaryMax: vacancySalary?.max ?? null,
							taxBase: data.vacancy.salary.taxBase,
							workFormat: data.vacancy.workFormat,
							contactKind: 'email',
							contactValue: '',
							contactNote: null,
							vacancyId: data.vacancy.status === 'published' ? data.vacancy.id : null,
							message: null,
							whyYou: []
						}}
						responseWindowHours={data.offer.responseWindowHours}
						problems={problem?.fields ?? {}}
					/>
				{/if}
			</Card.Content>
		</Card.Root>
	</aside>
</div>
