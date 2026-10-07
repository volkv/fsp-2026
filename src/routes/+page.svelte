<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import FspSign from '$lib/components/brand/fsp-sign.svelte';
	import { RecommendationNotice, TrustChip } from '$lib/components/product/index.js';
	import { TRUST, type TrustLevel } from '$lib/components/product/model.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import { SIGN_IN_HREF } from '$lib/navigation.js';

	const facts = [
		{
			value: '21,4 %',
			text: 'откликов соответствуют требованиям вакансии',
			source: 'Хантфлоу и Джун, первое полугодие 2026, 753 162 отклика в 133 компаниях',
			href: 'https://huntflow.media/iz-pyati-otklikov-na-vakansiyu-podhodit-tolko-odin/'
		},
		{
			value: '52 часа',
			text: 'проходит до первого действия рекрутера с откликом',
			source: 'Хантфлоу и Джун, первое полугодие 2026',
			href: 'https://huntflow.media/iz-pyati-otklikov-na-vakansiyu-podhodit-tolko-odin/'
		},
		{
			value: '44,5 дня',
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
			lead: 'Находите ИТ-специалистов по проверенным навыкам и пишите первыми — сразу с зарплатой.',
			points: [
				'Вставьте текст вакансии — система разложит его на роль, грейд, навыки и вилку.',
				'Кандидаты под вакансию с объяснением: что подходит, чем подтверждено, что проверить на собеседовании.',
				'Приглашение с вилкой и сроком ответа; отправленные условия не меняются задним числом.'
			]
		},
		{
			id: 'candidates',
			icon: UserRoundIcon,
			title: 'Кандидатам',
			lead: 'Ваши победы засчитываются в карьере — без откликов вслепую.',
			points: [
				'Профиль собирается сам: достижения ФСП через ФСП ID, разбор резюме, публичные профили.',
				'Видно, откуда взят каждый факт, почему вы в категории и что подтянуть до следующего грейда.',
				'Контакты раскрываются только компании, приглашение которой вы приняли.'
			]
		},
		{
			id: 'fsp',
			icon: TrophyIcon,
			title: 'Федерации',
			lead: 'Карьерный лифт федерации, который можно измерить.',
			points: [
				'Проверка работодателей и разбор возражений по категориям.',
				'Карьерные исходы участников по стадиям: приглашения, контакты, собеседования, выходы — и честно, где исход неизвестен.',
				'Какие навыки ищет рынок и какие дают соревнования.'
			]
		}
	];

	const steps = [
		{ title: 'Достижение', text: 'ФСП подтверждает факт: соревнование, результат, роль.' },
		{ title: 'Требование', text: 'Платформа показывает, что факт подтверждает для вакансии и чего не подтверждает.' },
		{ title: 'Приглашение', text: 'Работодатель пишет первым — с вакансией, вилкой и сроком ответа.' },
		{ title: 'Исход', text: 'Каждая сторона отмечает этапы найма; федерация видит, куда уходят участники.' }
	];

	const trustLadder: TrustLevel[] = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed'];
</script>

<svelte:head>
	<title>ФСП | Карьера — платформа ИТ-найма, где навыки подтверждены</title>
	<meta
		name="description"
		content="Работодатель сам находит ИТ-специалиста по проверяемому профилю и первым предлагает вакансию с зарплатой. Достижения подтверждает Федерация спортивного программирования."
	/>
</svelte:head>

<section class="relative overflow-hidden border-b bg-card">
	<div class="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:py-20">
		<div class="space-y-6">
			<p class="font-mono text-label text-link uppercase">Федерация спортивного программирования России</p>
			<h1 class="text-h1 sm:text-display">ФСП | Карьера</h1>
			<p class="font-heading text-h3 text-balance">Платформа ИТ-найма, где навыки подтверждены</p>
			<p class="max-w-xl text-lg text-muted-foreground">
				Работодатель сам находит ИТ-специалиста по проверяемому профилю и первым предлагает вакансию с зарплатой.
				Профиль категоризируется автоматически, а у каждого навыка видно, чем он подтверждён — и чего это подтверждение
				не доказывает.
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
		</div>
		<aside class="relative rounded-2xl border bg-background p-6" aria-labelledby="trust-ladder-title">
			<FspSign class="pointer-events-none absolute -top-10 -right-10 size-24 opacity-15" />
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
				<p class="font-heading text-metric text-link numeric">{fact.value}</p>
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
		Проверяемая связь «достижение → требование → приглашение → подтверждённый карьерный исход».
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
