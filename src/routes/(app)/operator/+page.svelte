<script lang="ts">
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const overview = $derived(data.overview);

	const queues = $derived([
		{
			key: 'companies',
			title: 'Проверка компаний',
			href: resolve('/operator/companies'),
			count: overview.companies.open,
			lines: [
				{ text: `просрочено: ${overview.companies.overdue}`, alert: overview.companies.overdue > 0 },
				{ text: 'решение — за оператором, реестр — подсказка', alert: false }
			]
		},
		{
			key: 'objections',
			title: 'Возражения по результатам тестов',
			href: resolve('/operator/objections'),
			count: overview.objections.open,
			lines: [
				{ text: `просрочено: ${overview.objections.overdue}`, alert: overview.objections.overdue > 0 },
				{ text: `срок в ближайшие 5 дней: ${overview.objections.dueSoon}`, alert: overview.objections.dueSoon > 0 },
				{ text: `без ответственного: ${overview.objections.unassigned}`, alert: false }
			]
		},
		{
			key: 'representatives',
			title: 'Представители 14–17 лет',
			href: resolve('/operator/representatives'),
			count: overview.representatives.awaiting,
			lines: [{ text: 'почта подтверждена, полномочия ждут проверки', alert: false }]
		},
		{
			key: 'ages',
			title: 'Конфликты возраста',
			href: resolve('/operator/ages'),
			count: overview.ages.open,
			lines: [{ text: 'дата рождения расходится с ФСП, профиль закрыт до проверки документа', alert: false }]
		},
		{
			key: 'attempts',
			title: 'Попытки тестов',
			href: resolve('/operator/assessments'),
			count: overview.attempts.attention,
			lines: [
				{ text: `без результата проверки: ${overview.attempts.stuck}`, alert: overview.attempts.stuck > 0 },
				{ text: 'вставки и уходы со страницы — повод посмотреть, не вердикт', alert: false }
			]
		},
		{
			key: 'vacancies',
			title: 'Модерация вакансий',
			href: resolve('/operator/vacancies'),
			count: overview.vacancies.pending,
			lines: [{ text: 'проверка текста нашла недопустимые требования', alert: false }]
		},
		{
			key: 'claims',
			title: '«Это наша вакансия»',
			href: resolve('/operator/claims'),
			count: overview.claims.pending,
			lines: [{ text: 'заявки проверенных компаний на внешние вакансии', alert: false }]
		}
	]);
</script>

<PageHeader
	title="Кабинет оператора ФСП"
	description="Очереди дел со сроками, партнёрства с соревнованиями и карьерные исходы участников федерации."
/>

<section aria-labelledby="queues-heading" class="grid gap-4">
	<h2 id="queues-heading" class="font-heading text-h3">Очереди</h2>
	<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
		{#each queues as queue (queue.key)}
			<li>
				<Card.Root class="h-full" data-queue={queue.key}>
					<Card.Header>
						<Card.Title>
							<h3 class="text-base font-medium">
								<a href={queue.href} class="underline-offset-4 hover:underline">{queue.title}</a>
							</h3>
						</Card.Title>
					</Card.Header>
					<Card.Content class="grid gap-2">
						<p class="font-heading text-h1 tabular-nums" data-count>{queue.count}</p>
						<ul class="grid gap-1 text-sm">
							{#each queue.lines as line (line.text)}
								<li class={cn(line.alert ? 'font-medium text-destructive' : 'text-muted-foreground')}>{line.text}</li>
							{/each}
						</ul>
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>
</section>

<section aria-labelledby="analytics-heading" class="grid gap-4">
	<h2 id="analytics-heading" class="font-heading text-h3">Карьерный лифт федерации</h2>
	<div class="grid gap-4 md:grid-cols-2">
		<Card.Root>
			<Card.Header>
				<Card.Title><h3 class="text-base font-medium">Карьерные исходы</h3></Card.Title>
				<Card.Description>
					Приглашения, контакты, собеседования, предложения и подтверждённые выходы — раздельно, с источником и
					неизвестными исходами.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<a href={resolve('/operator/outcomes')} class="text-sm font-medium text-link underline-offset-4 hover:underline"
					>Открыть воронку</a
				>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title><h3 class="text-base font-medium">Навыки рынка ↔ навыки ФСП</h3></Card.Title>
				<Card.Description>
					Что требуют вакансии и что подтверждают результаты соревнований — обратная связь для дисциплин и кейсов.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<a href={resolve('/operator/skills')} class="text-sm font-medium text-link underline-offset-4 hover:underline"
					>Открыть сопоставление</a
				>
			</Card.Content>
		</Card.Root>
	</div>
</section>
