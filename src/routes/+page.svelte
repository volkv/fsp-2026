<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PatternGraph from '$lib/components/brand/pattern-graph.svelte';
	import { RecommendationNotice, TrustChip } from '$lib/components/product/index.js';
	import { TRUST, pluralize, type TrustLevel } from '$lib/components/product/model.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import { SIGN_IN_HREF } from '$lib/navigation.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const description =
		'Работодатель сам находит ИТ-специалиста по проверенному профилю и первым предлагает работу с зарплатой. ' +
		'Грейд подтверждает тест, достижения — Федерация спортивного программирования.';

	const figureFormat = new Intl.NumberFormat('ru-RU');

	/** Figures of the platform from the database; a figure the database does not have yet is not shown. */
	const metrics = $derived.by(() => {
		const { taxonomy, taskFamilies } = data.metrics;
		const shown: { value: number; text: string }[] = [];
		if (taxonomy !== null && taxonomy.roles > 0) {
			shown.push({
				value: taxonomy.roles,
				text: `${pluralize(taxonomy.roles, ['ИТ-роль', 'ИТ-роли', 'ИТ-ролей'])} в справочнике категорий`
			});
		}
		if (taxonomy !== null && taxonomy.skills > 0) {
			shown.push({
				value: taxonomy.skills,
				text: `${pluralize(taxonomy.skills, ['навык', 'навыка', 'навыков'])} с синонимами из вакансий и резюме`
			});
		}
		if (taskFamilies > 0) {
			shown.push({
				value: taskFamilies,
				text: `${pluralize(taskFamilies, ['шаблон', 'шаблона', 'шаблонов'])} заданий: у каждого кандидата свои варианты`
			});
		}
		return shown;
	});

	const facts = [
		{
			value: '21,4',
			unit: '%',
			text: 'откликов соответствуют требованиям вакансии',
			source: 'Хантфлоу и Джун, первое полугодие 2026, 753 162 отклика в 133 компаниях',
			href: 'https://huntflow.media/iz-pyati-otklikov-na-vakansiyu-podhodit-tolko-odin/'
		},
		{
			value: '52',
			unit: 'часа',
			text: 'проходит до первого действия рекрутера с откликом',
			source: 'Хантфлоу и Джун, первое полугодие 2026',
			href: 'https://huntflow.media/iz-pyati-otklikov-na-vakansiyu-podhodit-tolko-odin/'
		},
		{
			value: '44,5',
			unit: 'дня',
			text: 'медиана закрытия ИТ-вакансии',
			source: 'Поток, 2025, 1 762 ИТ-вакансии',
			href: 'https://potok.io/blog/hr-news/time-to-hire-report-2025/'
		}
	];

	const audiences = [
		{
			id: 'employers',
			icon: BriefcaseIcon,
			title: 'Работодателям',
			lead: 'Находите ИТ-специалистов по проверенным навыкам и пишите первыми — сразу с зарплатой. Вакансия не нужна.',
			points: [
				'Опишите, кого ищете, своими словами или в форме — платформа предложит категории и покажет, сколько в них кандидатов.',
				'Подборка с объяснением по каждому кандидату: что подходит, чем подтверждено, что уточнить на собеседовании.',
				'Предложение с вилкой в рублях и пунктами «почему вы» — из подборки, по решению вызова или по отклику на вашу вакансию.'
			]
		},
		{
			id: 'candidates',
			icon: UserRoundIcon,
			title: 'Кандидатам',
			lead: 'Работодатели находят вас сами — без откликов вслепую.',
			points: [
				'Пройдите опрос, заявите грейд и подтвердите его тестом: ваша категория — специализация и грейд по тесту.',
				'Достижения ФСП через ФСП ID, резюме и публичные профили подтверждают навыки и влияют на место в подборке, но грейд не меняют.',
				'В предложении видно, что компания нашла в вашем профиле. Контакты получает только компания, чьё предложение вы приняли.'
			]
		},
		{
			id: 'fsp',
			icon: TrophyIcon,
			title: 'Федерации',
			lead: 'Карьерный лифт федерации, который можно измерить.',
			points: [
				'Проверка работодателей и разбор возражений по категориям.',
				'Карьерные исходы участников по стадиям: предложения компаний, контакты, собеседования, выходы — и честно, где исход неизвестен.',
				'Какие навыки ищет рынок и какие дают соревнования.'
			]
		}
	];

	const steps = [
		{
			title: 'Тест',
			text: 'Кандидат заявляет грейд и подтверждает его тестом; достижения ФСП и резюме добавляют доказательства.'
		},
		{
			title: 'Потребность',
			text: 'Работодатель описывает, кого ищет, и получает подборку проверенных кандидатов с объяснением.'
		},
		{
			title: 'Предложение',
			text: 'Работодатель пишет первым: вилка в рублях, «почему вы» и срок ответа. Вакансия не обязательна.'
		},
		{
			title: 'Исход',
			text: 'Принятое предложение открывает контакты и переписку; стороны отмечают этапы найма, федерация видит, куда уходят участники.'
		}
	];

	const trustLadder: TrustLevel[] = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed'];
</script>

<svelte:head>
	<title>ФСП | Карьера — платформа ИТ-найма, где навыки подтверждены</title>
	<meta name="description" content={description} />
	<meta property="og:type" content="website" />
	<meta property="og:url" content="{page.url.origin}/" />
	<meta property="og:title" content="ФСП | Карьера — платформа ИТ-найма, где навыки подтверждены" />
	<meta property="og:description" content={description} />
</svelte:head>

<!-- The first screen is a dark brand block in both themes, as the FSP carriers are: the dark tokens apply inside it. -->
<section class="dark relative overflow-hidden border-b bg-background text-foreground" aria-labelledby="hero-title">
	<PatternGraph class="[mask-image:linear-gradient(90deg,rgb(0_0_0/0.55),rgb(0_0_0/0.75)_40%,black_70%)]" />
	<div
		class="relative mx-auto grid max-w-7xl gap-10 px-4 pt-12 pb-14 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:pt-16 lg:pb-20"
	>
		<div class="space-y-6">
			<p class="font-mono text-label text-link uppercase">Федерация спортивного программирования России</p>
			<h1 id="hero-title" class="text-h1 sm:text-display">ФСП | Карьера</h1>
			<p class="font-heading text-h3 text-balance">Платформа ИТ-найма, где навыки подтверждены</p>
			<p class="max-w-xl text-lg text-muted-foreground">
				Работодатель сам находит ИТ-специалиста по проверенному профилю и первым предлагает работу с зарплатой.
				Категорию кандидата назначает только тест, а у каждого навыка видно, чем он подтверждён — и чего это
				подтверждение не доказывает.
			</p>
			<div class="flex flex-wrap gap-3">
				{#if SIGN_IN_HREF}
					<a href={resolve(SIGN_IN_HREF)} class={buttonVariants({ size: 'lg' })}>
						<LogInIcon aria-hidden="true" />
						Войти через ФСП ID
					</a>
				{/if}
				<a href="#how" class={buttonVariants({ size: 'lg', variant: 'outline' })}>
					Как это работает
					<ArrowRightIcon aria-hidden="true" />
				</a>
			</div>
			{#if metrics.length > 0}
				<dl class="grid max-w-xl grid-cols-3 gap-4 border-t pt-6" aria-label="Платформа в цифрах">
					{#each metrics as metric (metric.text)}
						<div class="flex flex-col-reverse justify-end gap-2">
							<dt class="text-sm text-muted-foreground">{metric.text}</dt>
							<dd class="accent-figure text-h1 sm:text-figure">{figureFormat.format(metric.value)}</dd>
						</div>
					{/each}
				</dl>
			{/if}
		</div>
		<aside class="rounded-2xl border bg-card p-6 lg:self-start" aria-labelledby="trust-ladder-title">
			<h2 id="trust-ladder-title" class="text-h3">Уровни доверия к навыку</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				От подтверждённого федерацией факта до слов кандидата — уровень всегда подписан.
			</p>
			<ol class="mt-5 space-y-4">
				{#each trustLadder as level (level)}
					<li class="grid gap-1.5">
						<TrustChip {level} signal size="md" class="justify-self-start" />
						<p class="text-sm text-muted-foreground">{TRUST[level].asserts}</p>
					</li>
				{/each}
			</ol>
		</aside>
	</div>
</section>

<section class="mx-auto max-w-7xl px-4 py-14 sm:px-6" aria-labelledby="facts-title">
	<h2 id="facts-title" class="text-h2">Почему найму в ИТ нужен другой порядок</h2>
	<ul class="mt-6 grid gap-4 md:grid-cols-3">
		{#each facts as fact (fact.value)}
			<li class="flex flex-col rounded-xl border bg-card p-5 shadow-xs">
				<p class="flex items-baseline gap-2 text-link">
					<span class="accent-figure text-figure">{fact.value}</span>
					<span class="font-heading text-h3">{fact.unit}</span>
				</p>
				<p class="mt-2">{fact.text}</p>
				<p class="mt-auto pt-4 text-xs text-muted-foreground">
					Источник: <a
						class="underline underline-offset-2 hover:text-foreground"
						href={fact.href}
						rel="external noreferrer">{fact.source}</a
					>
				</p>
			</li>
		{/each}
	</ul>
</section>

<section class="border-y bg-card" aria-labelledby="audiences-title">
	<div class="mx-auto max-w-7xl px-4 py-14 sm:px-6">
		<h2 id="audiences-title" class="text-h2">Для кого</h2>
		<div class="mt-6 grid gap-4 lg:grid-cols-3">
			{#each audiences as audience (audience.id)}
				<article id={audience.id} class="scroll-mt-24 rounded-xl border bg-background p-6">
					<div class="flex items-center gap-3">
						<span class="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
							<audience.icon class="size-5" aria-hidden="true" />
						</span>
						<h3 class="text-h3">{audience.title}</h3>
					</div>
					<p class="mt-4 font-medium">{audience.lead}</p>
					<ul class="mt-3 space-y-2 text-sm text-muted-foreground">
						{#each audience.points as point (point)}
							<li class="flex gap-2">
								<span class="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
								{point}
							</li>
						{/each}
					</ul>
				</article>
			{/each}
		</div>
	</div>
</section>

<section id="how" class="mx-auto max-w-7xl scroll-mt-24 px-4 py-14 sm:px-6" aria-labelledby="how-title">
	<h2 id="how-title" class="text-h2">Как это работает</h2>
	<p class="mt-2 max-w-2xl text-muted-foreground">
		От подтверждённого грейда до предложения с зарплатой и карьерного исхода — каждый шаг можно проверить.
	</p>
	<ol class="relative mt-8 grid gap-6 md:grid-cols-4">
		<span class="absolute top-4 right-[12.5%] left-[12.5%] hidden h-px bg-primary/50 md:block" aria-hidden="true"
		></span>
		{#each steps as step, index (step.title)}
			<li class="relative flex gap-4 md:flex-col md:items-center md:text-center">
				<span
					class={cn(
						'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background font-mono text-sm font-medium text-link'
					)}
				>
					{index + 1}
				</span>
				<div>
					<h3 class="text-h3">{step.title}</h3>
					<p class="mt-1 text-sm text-muted-foreground">{step.text}</p>
				</div>
			</li>
		{/each}
	</ol>
	<RecommendationNotice class="mt-10" />
</section>
