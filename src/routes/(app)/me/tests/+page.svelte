<script lang="ts">
	import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
	import CodeIcon from '@lucide/svelte/icons/code';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import { resolve } from '$app/paths';
	import AssessmentCard from '$lib/components/assessments/assessment-card.svelte';
	import HonestNote from '$lib/components/assessments/honest-note.svelte';
	import { QUIZ_NOTE } from '$lib/components/assessments/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const tasks = $derived(data.entries.filter((entry) => entry.kind === 'code_task'));
	const quizzes = $derived(data.entries.filter((entry) => entry.kind === 'quiz'));
</script>

<PageHeader
	title="Тесты платформы"
	description="Навык, который не подтверждают результаты ФСП, можно подтвердить здесь: решить практическую задачу — код проверяется в изолированной песочнице — или пройти адаптивный квиз. Засчитанный результат попадает в профиль с отметкой «Подтверждено платформой»."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

<SectionCard
	title="Практические задачи"
	description="Задача по стеку с автопроверкой: решение запускается в изолированной песочнице без сети на открытых и скрытых тестах. Одна попытка — одна отправка."
	testId="code-tasks"
>
	<HonestNote kind="code_task" />
	{#if tasks.length > 0}
		<ul class="grid gap-4 lg:grid-cols-2">
			{#each tasks as entry (entry.assessmentId)}<AssessmentCard {entry} skills={data.skills} />{/each}
		</ul>
	{:else}
		<Empty.Root class="border p-8">
			<Empty.Header>
				<Empty.Media variant="icon"><CodeIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Практических задач пока нет</Empty.Title>
			</Empty.Header>
		</Empty.Root>
	{/if}
</SectionCard>

<SectionCard title="Адаптивные квизы" description={QUIZ_NOTE} testId="quizzes">
	<HonestNote kind="quiz" />
	{#if quizzes.length > 0}
		<ul class="grid gap-4 lg:grid-cols-2">
			{#each quizzes as entry (entry.assessmentId)}<AssessmentCard {entry} skills={data.skills} />{/each}
		</ul>
	{:else}
		<Empty.Root class="border p-8">
			<Empty.Header>
				<Empty.Media variant="icon"><ListChecksIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Квизов пока нет</Empty.Title>
			</Empty.Header>
		</Empty.Root>
	{/if}
</SectionCard>

<p class="flex items-start gap-2 text-sm text-muted-foreground">
	<ClipboardCheckIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	Засчитывается лучшая попытка: повторные попытки одного задания не складываются. Твой код и ответы работодателю не показываются
	никогда: в профиле остаются навык с отметкой «Подтверждено платформой», уровень, дата и версия задания.
</p>
