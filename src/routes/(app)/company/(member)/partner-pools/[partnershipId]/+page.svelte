<script lang="ts">
	import { resolve } from '$app/paths';
	import UsersIcon from '@lucide/svelte/icons/users';
	import CandidateCard from '$lib/components/employer/candidate-card.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PartnerPoolMember from '$lib/components/employer/partner-pool-member.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { PARTNERSHIP_KINDS, POOL_AWARDS, POOL_STAGES } from '$lib/components/operator/model.js';
	import { formatDate } from '$lib/components/product/model.js';
	import { RecommendationNotice } from '$lib/components/product/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const partnership = $derived(data.partnership);
	const title = $derived(partnership.competitionTitle ?? `Соревнование ${partnership.competitionRef}`);
	const id = $props.id();
</script>

<PageHeader
	title={`Пул финалистов: ${title}`}
	description="Финалисты соревнования, которые согласились показать карточку партнёрам. Без имени и контактов: они — после принятия приглашения и только с согласия кандидата."
>
	{#snippet eyebrow()}
		<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/partner-pools')}>Пулы партнёра</a>
	{/snippet}
</PageHeader>

<p class="text-sm text-muted-foreground" data-testid="pool-partnership">
	{PARTNERSHIP_KINDS[partnership.kind] ?? partnership.kind} · в пуле {POOL_AWARDS[partnership.poolRule.min_award]}
	({partnership.poolRule.stages.map((stage) => POOL_STAGES[stage] ?? stage).join(', ')}) · действует с {formatDate(
		partnership.validFrom
	)}{partnership.validTo ? ` по ${formatDate(partnership.validTo)}` : ''}. Результат этого соревнования в карточке —
	точно, с квитанцией.
</p>

<RecommendationNotice compact />

<div class="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
	<aside class="lg:sticky lg:top-20 lg:self-start">
		<form method="GET" class="grid gap-4 rounded-xl border bg-card p-4" aria-label="Фильтры пула">
			<Field.Field>
				<Field.Label for="{id}-specialization">Специализация категории</Field.Label>
				<NativeSelect id="{id}-specialization" name="specialization" value={data.query.specializations[0] ?? ''}>
					<option value="">Любая</option>
					{#each data.filters.specializations as specialization (specialization.key)}
						<option value={specialization.key}>{specialization.name}</option>
					{/each}
				</NativeSelect>
			</Field.Field>
			<fieldset class="grid gap-2">
				<legend class="mb-1 text-sm font-medium">Грейд категории</legend>
				<div class="flex flex-wrap gap-x-4 gap-y-2">
					{#each data.filters.grades as grade (grade.key)}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="grade"
								value={grade.key}
								checked={(data.query.grades as readonly string[]).includes(grade.key)}
								class="size-4 accent-primary"
							/>
							{grade.name}
						</label>
					{/each}
				</div>
			</fieldset>
			<Button type="submit">Показать</Button>
		</form>
	</aside>

	<div class="grid content-start gap-4" data-testid="pool-members">
		{#each data.members as member (member.pseudonym)}
			<PartnerPoolMember
				pseudonym={member.pseudonym}
				result={member.result}
				categories={member.card.categories ?? []}
				labels={data.labels}
				offer={member.offer}
			>
				<CandidateCard
					card={member.card}
					evidenceState={member.evidenceState}
					receipts={member.receipts}
					labels={data.labels}
				/>
			</PartnerPoolMember>
		{:else}
			<Empty.Root class="border">
				<Empty.Header>
					<Empty.Media variant="icon"><UsersIcon aria-hidden="true" /></Empty.Media>
					<Empty.Title>В пуле пока никого</Empty.Title>
					<Empty.Description>
						Финалист попадает в пул, только когда сам согласится показать карточку партнёрам этого соревнования.
						Ослабьте фильтры или загляните позже.
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/each}
	</div>
</div>
