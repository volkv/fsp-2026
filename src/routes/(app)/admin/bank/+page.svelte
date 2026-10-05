<script lang="ts">
	import { points } from '$lib/components/assessments/model.js';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Release = (typeof data.releases)[number];
	type Reviewer = Release['reviews'][number]['rubricReviews'][number]['reviewer'];

	const releasedOf = (key: string) => data.releases.find((r) => r.specialization === key && r.status === 'released');
	const reviewerName = (reviewer: Reviewer) =>
		reviewer.kind === 'model' ? `модель ${reviewer.model} (линейка ${reviewer.lineage})` : `человек: ${reviewer.name}`;
	const stale = (current: boolean) => (current ? '' : ' — на прежних исходниках, не засчитано');
</script>

<PageHeader
	title="Банк заданий"
	description="Выпуски банка по специализациям: только выпуск подаётся кандидатам, и только выпуск, прошедший ворота семейств, проверку вместимости и симуляцию траекторий. Специализация открыта, когда она включена в справочнике и у неё есть выпуск."
/>

<Card.Root>
	<Card.Header><Card.Title>Специализации</Card.Title></Card.Header>
	<Card.Content>
		<ul class="grid gap-2 text-sm">
			{#each data.specializations as specialization (specialization.key)}
				{@const release = releasedOf(specialization.key)}
				<li class="flex flex-wrap items-center gap-2" data-testid="bank-specialization" data-key={specialization.key}>
					<span class="font-medium">{specialization.title}</span>
					<StatusPill
						label={specialization.availability === 'enabled' ? 'включена' : 'выключена'}
						tone={specialization.availability === 'enabled' ? 'info' : 'neutral'}
					/>
					<StatusPill label={release ? `выпуск ${release.id}` : 'выпуска нет'} tone={release ? 'success' : 'warning'} />
				</li>
			{/each}
		</ul>
	</Card.Content>
</Card.Root>

<Card.Root data-testid="bank-tree">
	<Card.Header>
		<Card.Title>Семейства в банке</Card.Title>
		<Card.Description>
			Каждое семейство проверено отдельно. Дефект — данные надо исправить; ожидание — семейство ждёт независимых
			Angoff-оценок или ревью рубрики на текущих исходниках. Выпуск не допускается ни с тем, ни с другим.
		</Card.Description>
	</Card.Header>
	<Card.Content class="grid gap-3 text-sm">
		{#each data.tree as spec (spec.specialization)}
			<div class="grid gap-1" data-testid="bank-tree-specialization" data-key={spec.specialization}>
				<p class="flex flex-wrap items-center gap-2">
					<span class="font-medium">{spec.specialization}</span>
					<span class="text-muted-foreground">семейств {spec.families}</span>
					<StatusPill label={`дефектов ${spec.defects.length}`} tone={spec.defects.length > 0 ? 'danger' : 'success'} />
					<StatusPill
						label={`ждут оценок и ревью ${spec.awaiting.length}`}
						tone={spec.awaiting.length > 0 ? 'warning' : 'success'}
					/>
				</p>
				{#if spec.defects.length > 0}
					<details data-testid="bank-tree-defects">
						<summary class="cursor-pointer">Дефекты</summary>
						<ul class="mt-1 grid gap-0.5">
							{#each spec.defects as message, index (index)}<li>{message}</li>{/each}
						</ul>
					</details>
				{/if}
				{#if spec.awaiting.length > 0}
					<details data-testid="bank-tree-awaiting">
						<summary class="cursor-pointer">Ожидают суждений</summary>
						<ul class="mt-1 grid gap-0.5">
							{#each spec.awaiting as problem, index (index)}
								<li>
									{problem.code === 'awaiting_raters' ? 'оценки Angoff' : 'ревью рубрики'}: {problem.message}
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</div>
		{:else}
			<p class="text-muted-foreground">В дереве банка нет семейств.</p>
		{/each}
	</Card.Content>
</Card.Root>

{#each data.releases as release (release.id)}
	<Card.Root data-testid="bank-release" data-status={release.status}>
		<Card.Header>
			<Card.Title>{release.id}</Card.Title>
			<Card.Description>
				{release.status === 'released' ? 'действует' : 'выведен'} · выпущен {formatDateTime(release.releasedAt)} · семейств
				{release.families} · процедура {release.procedureVersion} · sha256 {release.contentSha256.slice(0, 12)}
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-4 text-sm">
			<div class="overflow-x-auto">
				<table class="w-full">
					<thead class="text-left text-muted-foreground">
						<tr
							><th class="pr-4 font-medium">Грейд</th><th class="pr-4 font-medium">Семейств-уровней по блокам</th><th
								class="pr-4 font-medium">Опорные</th
							></tr
						>
					</thead>
					<tbody>
						{#each Object.entries(release.levelsByBlock) as [grade, blocks] (grade)}
							<tr class="border-t align-top">
								<td class="py-1 pr-4">{grade}</td>
								<td class="py-1 pr-4">
									{Object.entries(blocks)
										.map(([block, count]) => `${block}: ${count}`)
										.join(', ')}
								</td>
								<td class="py-1 pr-4">{release.anchors[grade]?.length ?? 0}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<details>
				<summary class="cursor-pointer">
					Вместимость: {release.capacity.filter((c) => c.ok).length} из {release.capacity.length} предельных траекторий
				</summary>
				<ul class="mt-2 grid gap-1">
					{#each release.capacity as check, index (index)}
						<li>
							{check.grade}
							{check.scenario} — {check.ok
								? 'обслуживается'
								: `не хватает: ${check.shortages.map((s) => `${s.step}: ${s.block} (слот ${s.position})`).join(', ')}`}
						</li>
					{/each}
				</ul>
			</details>
			<div class="grid gap-1" data-testid="bank-judgement">
				<p class="font-medium">Ревью и пороги</p>
				<p class="text-muted-foreground">
					Рубрики и Angoff-оценки проверяют независимые рецензенты: две модели разных линеек или человек команды. Порог
					по оценкам только моделей — предварительный.
				</p>
				<ul class="grid gap-1">
					{#each Object.entries(release.judgement) as [grade, j] (grade)}
						<li>
							{grade}: семейств-уровней {j.levels}, рубрика только от моделей — {j.rubricByModelsOnly}, предварительный
							порог — {j.angoffProvisional}, рецензент того же поставщика, что автор — {j.sameVendorReviewer}
						</li>
					{/each}
				</ul>
			</div>
			<details>
				<summary class="cursor-pointer">Рецензенты по семействам: {release.reviews.length}</summary>
				<ul class="mt-2 grid gap-2">
					{#each release.reviews as family (family.key)}
						<li class="grid gap-1" data-testid="bank-family-review" data-key={family.key}>
							<span class="font-medium">{family.key}</span>
							<span class="text-muted-foreground">
								авторы: {family.authors.join(', ')} · исходники sha256 {family.sourceSha256.slice(0, 12)}
							</span>
							<ul class="grid gap-0.5 pl-4">
								{#each family.rubricReviews as review, index (index)}
									<li>
										ревью {review.reviewedAt}: {reviewerName(review.reviewer)} — {review.verdict === 'approved'
											? 'одобрено'
											: 'нужны правки'}{review.remarks.length ? ` (${review.remarks.join('; ')})` : ''}{stale(
											review.onCurrentSources
										)}
									</li>
								{/each}
								{#each family.levels as level (level.grade)}
									<li>
										Angoff {level.grade}, раунд {level.round}, среднее {points(level.mean)}{level.sameVendorReviewer
											? ' · рецензент того же поставщика, что автор'
											: ''}:
										{level.ratings
											.map((r) => `${reviewerName(r.rater)} — ${points(r.p)}${stale(r.onCurrentSources)}`)
											.join('; ')}
									</li>
								{/each}
							</ul>
						</li>
					{/each}
				</ul>
			</details>
			{#if release.trajectories}
				<div class="grid gap-1">
					<p class="font-medium">Симуляция траекторий (машинные испытуемые, предположения названы)</p>
					<p class="text-muted-foreground">
						ρ = {points(release.trajectories.model.rho)}, групп практики {release.trajectories.model.practiceGroups}
					</p>
					<ul class="grid gap-1">
						{#each release.trajectories.grades as g (g.grade)}
							<li>
								{g.grade}:
								{#each g.points as p (p.shift)}
									сдвиг {points(p.shift)} — подтверждено {points(p.confirmed)}, «не определено» {points(p.undetermined)}
									({p.runs} прогонов);
								{/each}
								{#each g.consistency as c (c.shift)}согласованность при {points(c.shift)} — {points(c.value)};{/each}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
{/each}
