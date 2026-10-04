<script lang="ts">
	import { resolve } from '$app/paths';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { SKILL_KINDS, TAXONOMY_STATUSES } from '$lib/components/admin/model.js';
	import ParamValue from '$lib/components/admin/param-value.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const selected = $derived(data.taxonomy.selected);
	const codes = (values: string[]) => (values.length === 0 ? '—' : values.join(', '));
</script>

<PageHeader
	title="Таксономия"
	description="Версии справочника ролей, навыков с синонимами, грейдов и форматов. Версия неизменяема после публикации: изменение — новая версия, которую публикует посев при старте приложения."
>
	{#snippet actions()}
		<a
			class="text-sm font-medium text-link underline-offset-4 hover:underline"
			href={resolve('/admin/taxonomy/unknown-skills')}>Неизвестные навыки из вакансий</a
		>
	{/snippet}
</PageHeader>

<section aria-labelledby="versions-heading" class="grid gap-4">
	<h2 id="versions-heading" class="font-heading text-h3">Версии</h2>
	{#if data.taxonomy.versions.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><LayersIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Таксономия не опубликована</Empty.Title>
				<Empty.Description>Её публикует посев таксономии при старте приложения из каталога taxonomy/.</Empty.Description
				>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root label="Версии таксономии" data-testid="taxonomy-versions">
					<Table.Header>
						<Table.Row>
							<Table.Head>Версия</Table.Head>
							<Table.Head>Статус</Table.Head>
							<Table.Head>Опубликована</Table.Head>
							<Table.Head>Источники</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.taxonomy.versions as version (version.id)}
							{@const status = TAXONOMY_STATUSES[version.status]}
							<Table.Row aria-current={version.id === selected?.version.id ? 'true' : undefined}>
								<Table.Cell class="font-medium">
									<a class="underline-offset-4 hover:underline" href="{resolve('/admin/taxonomy')}?version={version.id}"
										>{version.label}</a
									>
								</Table.Cell>
								<Table.Cell
									>{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}</Table.Cell
								>
								<Table.Cell class="whitespace-nowrap">
									{version.publishedAt ? formatDateTime(version.publishedAt) : '—'}
								</Table.Cell>
								<Table.Cell><ParamValue value={version.sources} /></Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</section>

{#if selected}
	<section aria-labelledby="skills-heading" class="grid gap-4">
		<div class="flex flex-wrap items-end justify-between gap-4">
			<div class="grid gap-1">
				<h2 id="skills-heading" class="font-heading text-h3">Навыки версии {selected.version.label}</h2>
				<p class="text-sm text-muted-foreground">
					Всего навыков: {selected.counts.skills}, синонимов: {selected.counts.aliases}. Поиск — по названию, ключу и
					синонимам.
				</p>
			</div>
			<form method="GET" class="flex flex-wrap items-end gap-3" role="search">
				<input type="hidden" name="version" value={selected.version.id} />
				<Field.Field class="w-64">
					<Field.Label for="skill-q">Навык или синоним</Field.Label>
					<Input id="skill-q" name="q" value={data.query} />
				</Field.Field>
				<Button type="submit" variant="outline">Найти</Button>
			</form>
		</div>
		{#if selected.skills.length === 0}
			<p class="text-sm text-muted-foreground">Навыков по запросу «{data.query}» нет.</p>
		{:else}
			<Card.Root>
				<Card.Content>
					<Table.Root label="Навыки таксономии" data-testid="skills">
						<Table.Header>
							<Table.Row>
								<Table.Head>Навык</Table.Head>
								<Table.Head>Вид</Table.Head>
								<Table.Head>Синонимы</Table.Head>
								<Table.Head>Внешние коды</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each selected.skills as skill (skill.key)}
								<Table.Row data-skill={skill.key}>
									<Table.Cell>
										<span class="font-medium">{skill.name}</span>
										<span class="block font-mono text-xs text-muted-foreground">
											{skill.key}{skill.parentKey ? ` ← ${skill.parentKey}` : ''}
										</span>
									</Table.Cell>
									<Table.Cell>{SKILL_KINDS[skill.kind] ?? skill.kind}</Table.Cell>
									<Table.Cell class="max-w-md font-mono text-xs break-words whitespace-normal">
										{codes(skill.aliases)}
									</Table.Cell>
									<Table.Cell class="text-xs whitespace-normal">
										hh: {skill.externalIds.hh ?? '—'} · Хабр: {skill.externalIds.habr ?? '—'} · SO: {skill.externalIds
											.so ?? '—'}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
					{#if selected.skillsTruncated}
						<p class="mt-3 text-sm text-muted-foreground">Показаны первые — уточните поиск.</p>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	</section>

	<section aria-labelledby="roles-heading" class="grid gap-4">
		<h2 id="roles-heading" class="font-heading text-h3">Роли ({selected.counts.roles})</h2>
		<Card.Root>
			<Card.Content>
				<Table.Root label="Роли таксономии" data-testid="roles">
					<Table.Header>
						<Table.Row>
							<Table.Head>Роль</Table.Head>
							<Table.Head>Семейство</Table.Head>
							<Table.Head>Типичные навыки</Table.Head>
							<Table.Head>hh.ru · Хабр · профстандарт</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each selected.roles as role (role.key)}
							<Table.Row data-role={role.key}>
								<Table.Cell>
									<span class="font-medium">{role.nameRu}</span>
									<span class="block font-mono text-xs text-muted-foreground">{role.key}</span>
								</Table.Cell>
								<Table.Cell>{role.family}</Table.Cell>
								<Table.Cell class="max-w-md font-mono text-xs break-words whitespace-normal">
									{codes(role.typicalSkills)}
								</Table.Cell>
								<Table.Cell class="font-mono text-xs whitespace-normal">
									{codes(role.hhRoleId)} · {codes(role.habrSpec)} · {codes(role.profStandard)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	</section>

	<div class="grid gap-4 md:grid-cols-2">
		<Card.Root>
			<Card.Header><Card.Title><h2 class="font-heading text-h3">Грейды</h2></Card.Title></Card.Header>
			<Card.Content>
				<ol class="grid gap-1 text-sm">
					{#each selected.grades as grade (grade.key)}
						<li>
							<span class="text-muted-foreground tabular-nums">{grade.ordinal}.</span>
							{grade.name}
							<span class="font-mono text-xs text-muted-foreground">{grade.key}</span>
						</li>
					{/each}
				</ol>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header><Card.Title><h2 class="font-heading text-h3">Форматы работы</h2></Card.Title></Card.Header>
			<Card.Content>
				<ul class="grid gap-1 text-sm">
					{#each selected.formats as format (`${format.dimension}:${format.key}`)}
						<li>
							<span class="font-mono text-xs text-muted-foreground">{format.dimension}</span>
							{format.name}
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	</div>
{/if}
