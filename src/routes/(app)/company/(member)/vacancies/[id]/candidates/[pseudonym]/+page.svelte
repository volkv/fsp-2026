<script lang="ts">
	import { resolve } from '$app/paths';
	import CandidateCard from '$lib/components/employer/candidate-card.svelte';
	import InviteForm from '$lib/components/employer/invite-form.svelte';
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
</script>

<PageHeader
	title={`Кандидат ${data.pseudonym}`}
	description="Псевдоним виден только вашей компании. Имя и контакты — после принятия приглашения и только с согласия кандидата."
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
			<Card.Root>
				<Card.Content>
					<MatchBreakdown {match} />
				</Card.Content>
			</Card.Root>
		{/if}
		<CandidateCard card={data.card} evidenceState={data.evidenceState} receipts={data.receipts} labels={data.labels} />
	</div>

	<aside class="grid content-start gap-4 lg:sticky lg:top-20 lg:self-start">
		<RecommendationNotice compact />
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Пригласить</h2></Card.Title>
				<Card.Description>На вакансию «{data.vacancy.title}» — сразу с вилкой и сроком ответа.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4">
				{#if problem}
					<FormMessage text={problem.message} />
				{/if}
				{#if data.invitation}
					<div class="flex flex-wrap items-center gap-2 text-sm" data-testid="existing-invitation">
						<InvitationStatus status={data.invitation.status} />
						<span class="text-muted-foreground">Приглашение по этой вакансии уже отправлено.</span>
					</div>
					<a
						class={buttonVariants({ variant: 'outline' })}
						href={resolve('/(app)/company/(member)/invitations/[id]', { id: data.invitation.id })}
					>
						Открыть приглашение
					</a>
				{:else if data.vacancy.status !== 'published'}
					<p class="text-sm text-muted-foreground">
						Приглашать можно по опубликованной вакансии. Опубликуйте её, чтобы отправить приглашение.
					</p>
				{:else}
					<InviteForm
						action="?/invite"
						salary={data.vacancy.salary}
						responseWindowHours={data.responseWindowHours}
						problems={problem?.fields ?? {}}
					/>
				{/if}
			</Card.Content>
		</Card.Root>
	</aside>
</div>
