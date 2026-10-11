<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import PlayIcon from '@lucide/svelte/icons/play';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import FspSign from '$lib/components/brand/fsp-sign.svelte';
	import { RecommendationNotice, TrustChip, TrustSignal } from '$lib/components/product/index.js';
	import { TRUST } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';
	import { DEMO_HREF, SIGN_IN_HREF } from '$lib/navigation.js';
	import AudiencesScroll from './audiences-scroll.svelte';
	import MarketFacts from './market-facts.svelte';
	import ProfileSnapshot from './profile-snapshot.svelte';
	import LedFigure from './led-figure.svelte';
	import RadarGraph from './radar-graph.svelte';
	import { reveal } from './reveal.js';
	import {
		AUDIENCES as audiences,
		FACTS as facts,
		HERO as hero,
		PROMISE as promise,
		STEPS as steps,
		TITLE as title,
		TRUST_LADDER as trustLadder,
		type Metric
	} from './content.js';

	/** The landing page: one statement per screen, a floating product shot, numbers the size of a slide. */
	let { metrics }: { metrics: Metric[] } = $props();

	/** The closing statement is the candidates' lead; a heading carries no final full stop. */
	const closing = (audiences.find((audience) => audience.id === 'candidates')?.lead ?? '').replace(/\.$/, '');

	/**
	 * The first screen turns between the sides on a timer that waits while the pointer or focus is on the statement.
	 * A choice of the visitor stops the turning; with reduced motion it does not turn at all.
	 */
	const TURN_MS = 8000;
	let active = $state(0);
	let previous = $state(-1);
	let held = $state(false);
	let chosen = $state(false);

	function show(index: number): void {
		if (index === active) return;
		previous = active;
		active = index;
	}

	function choose(index: number): void {
		chosen = true;
		show(index);
	}

	$effect(() => {
		if (chosen || held || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const next = (active + 1) % hero.length;
		const timer = window.setTimeout(() => {
			show(next);
		}, TURN_MS);
		return () => {
			window.clearTimeout(timer);
		};
	});

	function slideState(index: number): 'shown' | 'in' | 'out' | 'idle' {
		if (index === active) return previous === -1 ? 'shown' : 'in';
		return index === previous ? 'out' : 'idle';
	}

	const pill =
		'inline-flex h-12 items-center justify-center gap-2 rounded-full px-7 text-base font-medium transition-colors duration-300 sm:h-14 sm:px-8';
	const heading = 'text-[clamp(1.6rem,4vw,3.3rem)] leading-[1.02] font-bold tracking-[-0.04em] text-balance';
</script>

<!-- The first screen is dark in both themes, edge to edge; the header lies over it and is pinned once it has left the window. -->
<section
	class="dark relative isolate overflow-hidden bg-ink-900 text-foreground"
	aria-labelledby="keynote-title"
	data-under-header
>
	<div
		class="keynote-glow pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[70%] bg-[radial-gradient(ellipse_60%_50%_at_50%_85%,rgb(64_47_255/0.4),transparent_70%)]"
		aria-hidden="true"
	></div>
	<!-- To employers the glow warms toward the federation red. -->
	<div
		class={cn(
			'pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[70%] transition-opacity duration-[1600ms] ease-standard',
			hero[active]?.audience === 'employers' ? 'opacity-100' : 'opacity-0'
		)}
		aria-hidden="true"
	>
		<div
			class="keynote-glow size-full bg-[radial-gradient(ellipse_45%_40%_at_70%_80%,rgb(236_29_53/0.3),transparent_70%)]"
		></div>
	</div>
	<RadarGraph class="[mask-image:radial-gradient(ellipse_42%_38%_at_50%_42%,rgb(0_0_0/0.2),black_75%)]" />
	<div
		class="relative mx-auto flex min-h-dvh max-w-6xl flex-col items-center justify-center px-4 pt-[calc(var(--header-height)+2rem)] pb-[clamp(12rem,32vh,20rem)] text-center sm:px-6"
	>
		<div class="keynote-in flex items-center gap-3" style="--d: 0ms">
			<FspSign class="size-6" />
			<h1 id="keynote-title" class="font-mono text-sm tracking-[0.2em] text-ink-150 uppercase sm:text-base">
				{title}
			</h1>
		</div>
		<div
			class="flex w-full flex-col items-center"
			role="presentation"
			onpointerenter={() => (held = true)}
			onpointerleave={() => (held = false)}
			onfocusin={() => (held = true)}
			onfocusout={() => (held = false)}
		>
			<div
				class="keynote-in relative mt-8 grid auto-cols-fr grid-flow-col rounded-full bg-white/[0.06] p-[3px] ring-1 ring-white/15 backdrop-blur-sm"
				style="--d: 60ms"
				role="group"
				aria-label="Для кого"
			>
				<span
					class="absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-full bg-white/15 transition-transform duration-500 ease-standard"
					style="transform: translateX({active * 100}%)"
					aria-hidden="true"
				></span>
				{#each hero as slide, index (slide.audience)}
					<button
						type="button"
						class={cn(
							'relative h-7.5 rounded-full px-3.5 text-xs font-medium transition-colors duration-300 sm:h-8 sm:px-5 sm:text-[0.8125rem]',
							index === active ? 'text-white' : 'text-ink-250 hover:text-white'
						)}
						aria-pressed={index === active}
						aria-controls="hero-{slide.audience}"
						onclick={() => {
							choose(index);
						}}
					>
						{slide.label}
					</button>
				{/each}
			</div>
			<!-- The slides share one cell, so the screen keeps the height of the longest and nothing below it jumps. -->
			<div class="mt-8 grid w-full justify-items-center" aria-live={chosen ? 'polite' : 'off'}>
				{#each hero as slide, index (slide.audience)}
					<div
						id="hero-{slide.audience}"
						class="hero-slide flex flex-col items-center [grid-area:1/1]"
						data-state={slideState(index)}
						aria-hidden={index !== active}
						inert={index !== active}
					>
						<p
							class="font-heading text-[clamp(1.802rem,min(8.67vw,10.838vh),6.859rem)] leading-[0.95] font-bold tracking-[-0.05em]"
						>
							<span class="keynote-in block" style="--d: 120ms">
								<span class="hero-line block" style="--i: 0">{slide.lead}</span>
							</span>
							<span class="keynote-in block" style="--d: 280ms">
								<span
									class="hero-line block bg-linear-to-r from-brand-300 via-brand-200 to-white bg-clip-text pb-[0.08em] text-transparent"
									style="--i: 1"
								>
									{slide.accent}
								</span>
							</span>
						</p>
						<p class="keynote-in mt-8 max-w-2xl text-lg text-balance text-ink-150 sm:text-2xl" style="--d: 440ms">
							<span class="hero-line block" style="--i: 2">{slide.text}</span>
						</p>
					</div>
				{/each}
			</div>
		</div>
		<div class="keynote-in mt-10 flex flex-wrap items-center justify-center gap-4" style="--d: 560ms">
			<a href={resolve(DEMO_HREF)} class="{pill} bg-white text-ink-1000 hover:bg-brand-100">
				<PlayIcon class="size-5" aria-hidden="true" />
				Демо: войти за героя
			</a>
			{#if SIGN_IN_HREF}
				<a
					href={resolve(SIGN_IN_HREF)}
					class="{pill} text-brand-300 ring-1 ring-white/20 hover:bg-white/10 hover:text-white"
				>
					<LogInIcon class="size-5" aria-hidden="true" />
					Войти через ФСП ID
				</a>
			{/if}
			<a href="#how" class="{pill} text-brand-300 ring-1 ring-white/20 hover:bg-white/10 hover:text-white">
				Как это работает
				<ArrowRightIcon class="size-5" aria-hidden="true" />
			</a>
		</div>
	</div>
</section>

<!-- The product shot overlaps the first screen and straightens as it scrolls in. -->
<div
	class="relative z-10 -mt-(--overlap) overflow-x-clip px-4 pb-24 [--overlap:clamp(10rem,27vh,17rem)] sm:px-6 lg:pb-32"
>
	<div class="keynote-stage mx-auto max-w-3xl">
		<div class="keynote-tilt relative">
			<div
				class="pointer-events-none absolute inset-x-[10%] -bottom-16 -z-10 h-40 rounded-full bg-brand-500/50 blur-[80px]"
				aria-hidden="true"
			></div>
			<ProfileSnapshot />
		</div>
	</div>
	{#if metrics.length > 0}
		<dl
			class="group mx-auto mt-20 grid max-w-4xl grid-cols-3 gap-3 text-center sm:gap-10 lg:mt-32"
			aria-label="Платформа в цифрах"
			use:reveal={0.4}
		>
			{#each metrics as metric, index (metric.text)}
				<div
					class="flex flex-col-reverse justify-end gap-2 transition-all duration-700 ease-standard group-data-[reveal=pending]:translate-y-8 group-data-[reveal=pending]:opacity-0 sm:gap-3"
					style="transition-delay: {index * 120}ms"
				>
					<dt class="mx-auto max-w-56 text-xs leading-snug text-muted-foreground sm:text-sm">{metric.text}</dt>
					<dd>
						<LedFigure
							value={metric.value}
							class="text-[clamp(1.75rem,5.058vw,3.612rem)] leading-none text-foreground"
						/>
					</dd>
				</div>
			{/each}
		</dl>
	{/if}
</div>

<MarketFacts {facts} />

<!-- How it works: the four stages to a decision on a line that draws itself, dark as the first screen. -->
<section
	id="how"
	class="dark relative scroll-mt-24 overflow-hidden bg-ink-900 text-foreground"
	aria-labelledby="keynote-how-title"
>
	<div
		class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_15%_20%,rgb(64_47_255/0.22),transparent_70%)]"
		aria-hidden="true"
	></div>
	<div class="relative mx-auto max-w-6xl px-4 py-28 sm:px-6 lg:py-36">
		<div class="group" use:reveal={0.4}>
			<p
				class="font-mono text-label text-brand-300 uppercase transition-all duration-700 ease-standard group-data-[reveal=pending]:translate-y-4 group-data-[reveal=pending]:opacity-0"
			>
				Как это работает
			</p>
			<h2
				id="keynote-how-title"
				class="{heading} mt-4 max-w-3xl text-ink-50 transition-all delay-100 duration-1000 ease-standard group-data-[reveal=pending]:translate-y-8 group-data-[reveal=pending]:opacity-0"
			>
				Четыре стадии до&nbsp;решения
			</h2>
		</div>
		<ol class="group relative mt-14 grid gap-5 lg:mt-20 lg:grid-cols-4 lg:gap-6" use:reveal={0.25}>
			<span class="absolute top-5 right-0 left-0 hidden h-px bg-white/10 lg:block" aria-hidden="true"></span>
			<span
				class="absolute top-5 right-0 left-0 hidden h-px origin-left bg-linear-to-r from-brand-500 via-brand-300 to-fsp-red-500 transition-transform duration-[1600ms] ease-standard group-data-[reveal=pending]:scale-x-0 lg:block"
				aria-hidden="true"
			></span>
			{#each steps as step, index (step.title)}
				{@const final = index === steps.length - 1}
				<li class="relative flex flex-col">
					<span
						class={cn(
							'absolute top-5 right-5 z-10 flex size-10 items-center justify-center rounded-full border-2 bg-ink-900 accent-figure text-lg leading-none transition-all duration-500 ease-standard group-data-[reveal=pending]:scale-50 group-data-[reveal=pending]:opacity-0 lg:relative lg:top-auto lg:right-auto',
							final ? 'border-fsp-red-400 text-white' : 'border-brand-400 text-brand-200'
						)}
						style="transition-delay: {200 + index * 300}ms"
						aria-hidden="true"
					>
						{index + 1}
					</span>
					<article
						class={cn(
							'flex flex-1 flex-col rounded-3xl p-6 transition-all duration-1000 ease-standard group-data-[reveal=pending]:translate-y-12 group-data-[reveal=pending]:opacity-0 group-data-[reveal=pending]:blur-sm lg:mt-6 lg:p-7',
							final
								? 'bg-brand-500 text-white shadow-[0_20px_60px_-20px_rgb(64_47_255/0.9)]'
								: 'border border-white/10 bg-white/[0.04]'
						)}
						style="transition-delay: {350 + index * 300}ms"
					>
						<div class="hidden items-center justify-between gap-3 lg:flex">
							<span
								class={cn('font-mono text-label uppercase', final ? 'text-white' : 'text-ink-250')}
								aria-hidden="true"
							>
								Стадия {index + 1}
							</span>
							{#if final}
								<TrophyIcon class="size-5 shrink-0 lg:size-6" aria-hidden="true" />
							{/if}
						</div>
						<h3
							class="flex min-h-10 items-center pr-14 font-heading text-xl font-bold text-ink-50 lg:mt-5 lg:block lg:min-h-0 lg:pr-0 lg:text-2xl"
						>
							<span class="sr-only">Стадия {index + 1}. </span>{step.title}
						</h3>
						<p class={cn('mt-3 leading-relaxed', final ? 'text-brand-50' : 'text-ink-250')}>{step.text}</p>
					</article>
				</li>
			{/each}
		</ol>
		<RecommendationNotice compact class="mt-14 w-fit max-w-full" />
	</div>
</section>

<AudiencesScroll />

<!-- Trust levels as a contest scoreboard, in the page theme. -->
<section class="relative overflow-hidden border-y bg-card text-foreground" aria-labelledby="keynote-trust-title">
	<div class="keynote-grid pointer-events-none absolute inset-0" aria-hidden="true"></div>
	<div class="relative mx-auto max-w-6xl px-4 py-28 sm:px-6 lg:py-36">
		<p class="font-mono text-label text-link uppercase">Доверие</p>
		<h2 id="keynote-trust-title" class="{heading} mt-4 max-w-4xl">У каждого навыка виден уровень доверия</h2>
		<ol class="group mt-12 space-y-3 md:hidden" use:reveal={0.15}>
			{#each trustLadder as level, index (level)}
				<li
					class="rounded-2xl border bg-background p-5 transition-all duration-700 ease-standard group-data-[reveal=pending]:translate-y-6 group-data-[reveal=pending]:opacity-0"
					style="transition-delay: {index * 120}ms"
				>
					<div class="flex items-center justify-between gap-3">
						<span class="flex items-center gap-3">
							<span
								class={cn('accent-figure text-3xl leading-none', index === 0 ? 'text-link' : 'text-foreground')}
								aria-hidden="true">{index + 1}</span
							>
							<TrustChip {level} size="md" />
						</span>
						<span class="text-link">
							<TrustSignal filled={TRUST[level].nodes} class="h-3 w-10" />
						</span>
					</div>
					<p class="mt-3 text-sm leading-relaxed text-muted-foreground">
						<span class="sr-only">Ранг {index + 1}. </span>{TRUST[level].asserts}
					</p>
				</li>
			{/each}
		</ol>
		<div class="mt-14 hidden overflow-x-auto rounded-2xl border bg-background md:block lg:mt-20">
			<table class="w-full min-w-[40rem] border-collapse text-left">
				<caption class="sr-only">Уровни доверия к навыку, от сильного к слабому</caption>
				<thead>
					<tr class="border-b font-mono text-xs text-muted-foreground uppercase">
						<th scope="col" class="w-20 px-6 py-4 font-medium">Ранг</th>
						<th scope="col" class="px-4 py-4 font-medium">Источник</th>
						<th scope="col" class="px-4 py-4 font-medium">Что подтверждает</th>
						<th scope="col" class="w-28 px-6 py-4 text-right font-medium">Сигнал</th>
					</tr>
				</thead>
				<tbody class="group" use:reveal={0.2}>
					{#each trustLadder as level, index (level)}
						<tr
							class="border-b transition-all duration-700 ease-standard group-data-[reveal=pending]:-translate-x-10 group-data-[reveal=pending]:opacity-0 last:border-0 hover:bg-muted/60"
							style="transition-delay: {index * 140}ms"
						>
							<td class="px-6 py-7 align-top">
								<span
									class={cn(
										'accent-figure text-[1.488rem] leading-none',
										index === 0 ? 'text-link' : 'text-foreground'
									)}
								>
									{index + 1}
								</span>
							</td>
							<td class="px-4 py-7 align-top">
								<TrustChip {level} size="md" />
							</td>
							<td class="max-w-xl px-4 py-7 align-top text-muted-foreground">{TRUST[level].asserts}</td>
							<td class="px-6 py-7 text-right align-top">
								<span class="inline-flex pt-2 text-link">
									<TrustSignal filled={TRUST[level].nodes} class="h-3 w-10" />
								</span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<!-- Closing call. -->
<section class="dark relative isolate overflow-hidden bg-ink-900 text-foreground" aria-labelledby="keynote-final-title">
	<div
		class="keynote-glow pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_55%_45%_at_50%_45%,rgb(64_47_255/0.35),transparent_70%)]"
		aria-hidden="true"
	></div>
	<div class="group mx-auto max-w-5xl px-4 pt-28 pb-32 text-center sm:px-6 lg:pt-40 lg:pb-44" use:reveal={0.3}>
		<div
			class="flex justify-center transition-all duration-700 ease-standard group-data-[reveal=pending]:translate-y-6 group-data-[reveal=pending]:opacity-0"
		>
			<FspSign class="size-12" />
		</div>
		<h2
			id="keynote-final-title"
			class="mx-auto mt-8 max-w-4xl text-[clamp(1.806rem,5.1vw,4.356rem)] leading-[0.98] font-bold tracking-[-0.04em] text-balance text-ink-50 transition-all delay-150 duration-1000 ease-standard group-data-[reveal=pending]:translate-y-10 group-data-[reveal=pending]:opacity-0"
		>
			{closing}
		</h2>
		<p
			class="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-ink-250 transition-all delay-300 duration-700 ease-standard group-data-[reveal=pending]:translate-y-6 group-data-[reveal=pending]:opacity-0"
		>
			{promise.employer}
		</p>
		<div
			class="mt-12 flex flex-wrap items-center justify-center gap-4 transition-all delay-500 duration-700 ease-standard group-data-[reveal=pending]:translate-y-6 group-data-[reveal=pending]:opacity-0"
		>
			<a href={resolve(DEMO_HREF)} class="{pill} bg-white text-ink-1000 hover:bg-brand-100">
				<PlayIcon class="size-5" aria-hidden="true" />
				Демо: войти за героя
			</a>
			{#if SIGN_IN_HREF}
				<a
					href={resolve(SIGN_IN_HREF)}
					class="{pill} text-brand-300 ring-1 ring-white/20 hover:bg-white/10 hover:text-white"
				>
					<LogInIcon class="size-5" aria-hidden="true" />
					Войти через ФСП ID
				</a>
			{/if}
			<a href="#employers" class="{pill} text-brand-300 ring-1 ring-white/20 hover:bg-white/10 hover:text-white">
				Работодателям
				<ArrowRightIcon class="size-5" aria-hidden="true" />
			</a>
		</div>
	</div>
</section>

<style>
	/* Entrance of the first screen: each line rises out of a blur, one after another. */
	@media (prefers-reduced-motion: no-preference) {
		.keynote-in {
			animation: keynote-in 1s var(--ease-standard) both;
			animation-delay: var(--d);
		}
		.keynote-glow {
			animation: keynote-breathe 7s ease-in-out infinite alternate;
		}
	}

	/* Scroll-driven motion where the browser has it: transforms only, so contrast never depends on scroll. */
	@supports (animation-timeline: view()) {
		@media (prefers-reduced-motion: no-preference) {
			.keynote-stage {
				perspective: 1800px;
			}
			.keynote-tilt {
				transform-origin: 50% 100%;
				animation: keynote-straighten linear both;
				animation-timeline: view();
				animation-range: entry 0% cover 45%;
			}
		}
	}

	.keynote-grid {
		background-image:
			linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px);
		background-size: 48px 48px;
		mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent);
	}

	/* The turn between the sides: the leaving lines rise into a blur, the coming ones settle out of it, line after line. */
	.hero-slide[data-state='idle'] .hero-line,
	.hero-slide[data-state='out'] .hero-line {
		visibility: hidden;
		opacity: 0;
	}
	@media (prefers-reduced-motion: no-preference) {
		.hero-slide[data-state='in'] .hero-line {
			animation: hero-in 0.9s var(--ease-standard) both;
			animation-delay: calc(0.3s + var(--i) * 90ms);
		}
		.hero-slide[data-state='out'] .hero-line {
			animation: hero-out 0.5s var(--ease-standard) both;
			animation-delay: calc(var(--i) * 60ms);
		}
	}

	@keyframes hero-in {
		from {
			opacity: 0;
			transform: translateY(0.5em);
			filter: blur(14px);
		}
		to {
			opacity: 1;
			transform: none;
			filter: none;
		}
	}

	@keyframes hero-out {
		from {
			visibility: visible;
			opacity: 1;
			transform: none;
			filter: none;
		}
		to {
			visibility: hidden;
			opacity: 0;
			transform: translateY(-0.35em);
			filter: blur(14px);
		}
	}

	@keyframes keynote-in {
		from {
			opacity: 0;
			transform: translateY(2rem);
			filter: blur(12px);
		}
		to {
			opacity: 1;
			transform: none;
			filter: none;
		}
	}

	@keyframes keynote-breathe {
		from {
			opacity: 0.7;
			transform: scale(1);
		}
		to {
			opacity: 1;
			transform: scale(1.08);
		}
	}

	@keyframes keynote-straighten {
		from {
			transform: rotateX(24deg) translateY(2.5rem) scale(0.9);
		}
		to {
			transform: none;
		}
	}
</style>
