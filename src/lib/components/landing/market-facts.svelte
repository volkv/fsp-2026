<script lang="ts">
	import { PROMISE, type Fact } from './content.js';

	/**
	 * The market figures, each drawn as data: a hundred responses with the suitable ones lit, the hours to the first
	 * look on a two-day track, the days to close a vacancy as a calendar (the figures in the order of `FACTS`). The
	 * drawings fill in once the cards are in view.
	 */
	let { facts }: { facts: Fact[] } = $props();

	function amount(fact: Fact | undefined): number {
		return fact ? Number(fact.value.replace(',', '.')) : 0;
	}

	/** Hours shown on the track: a little past the figure, so the marker sits inside it. */
	const TRACK_HOURS = 60;
	/** A hundred responses, one dot each. */
	const DOTS = [...Array(100).keys()];

	const suitableCount = $derived(Math.round(amount(facts[0])));
	const waitingShare = $derived((amount(facts[1]) / TRACK_HOURS) * 100);
	const closingDays = $derived(amount(facts[2]));
	const calendar = $derived([...Array(Math.ceil(closingDays)).keys()]);

	let grid: HTMLElement | undefined = $state();
	let shown = $state(true);

	$effect(() => {
		if (!grid || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		shown = false;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					shown = true;
					observer.disconnect();
				}
			},
			{ rootMargin: '0px 0px -20% 0px' }
		);
		observer.observe(grid);
		return () => {
			observer.disconnect();
		};
	});
</script>

<section class="border-t bg-background" aria-labelledby="keynote-facts-title">
	<div class="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
		<div class="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
			<div>
				<p class="font-mono text-label text-link uppercase">Рынок</p>
				<h2
					id="keynote-facts-title"
					class="mt-4 text-[clamp(1.6rem,3.2vw,2.6rem)] leading-[1.05] font-bold tracking-[-0.04em] text-balance"
				>
					Почему найму в ИТ нужен другой порядок
				</h2>
			</div>
			<p class="text-lg text-balance text-muted-foreground">
				Отклики вслепую ждут в очереди рекрутера. <span class="text-foreground">{PROMISE.employer}</span>
			</p>
		</div>

		<ul bind:this={grid} class="mt-10 grid gap-3 sm:mt-14 sm:gap-4 md:grid-cols-3" data-shown={shown}>
			{#each facts as fact, index (fact.value)}
				<!-- Narrow windows: the figure beside its drawing, the caption under both; wide ones: a column. -->
				<li
					class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-5 gap-y-2 rounded-2xl border bg-card p-5 sm:rounded-3xl sm:p-6 md:flex md:flex-col md:items-stretch md:p-8"
				>
					<div class="order-2 flex flex-col justify-center md:order-none md:h-24" aria-hidden="true">
						{#if index === 0}
							<div class="grid grid-cols-20 gap-[3px]">
								{#each DOTS as dot (dot)}
									<span
										class={[
											'aspect-square rounded-full',
											dot < suitableCount ? 'cell-on bg-brand-500' : 'bg-muted-foreground/20'
										]}
										style:--i={dot}
									></span>
								{/each}
							</div>
						{:else if index === 1}
							<div class="relative h-2 rounded-full bg-muted">
								<div
									class="track-fill absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-brand-300 to-brand-500"
									style:width="{waitingShare}%"
								></div>
								<span
									class="track-marker absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-card bg-brand-red"
									style:left="{waitingShare}%"
								></span>
							</div>
							<!-- Marks at their places on the track: a day is 24 of its hours, two days 48. -->
							<div class="relative mt-2 h-4 font-mono text-xs text-muted-foreground md:mt-3">
								<span class="absolute left-0">0 ч</span>
								<span class="absolute hidden -translate-x-1/2 md:inline" style:left="{(24 / TRACK_HOURS) * 100}%"
									>сутки</span
								>
								<span class="absolute -translate-x-1/2 whitespace-nowrap" style:left="{(48 / TRACK_HOURS) * 100}%">
									<span class="md:hidden">48 ч</span><span class="hidden md:inline">двое суток</span>
								</span>
							</div>
						{:else if index === 2}
							<div class="grid grid-cols-15 gap-1">
								{#each calendar as day (day)}
									<span
										class={[
											'cell-on aspect-square rounded-[3px]',
											day + 1 <= closingDays ? 'bg-brand-500' : 'bg-linear-to-r from-brand-500 from-50% to-muted to-50%'
										]}
										style:--i={day * 2}
									></span>
								{/each}
							</div>
						{/if}
					</div>
					<p class="order-1 flex items-baseline gap-1.5 text-link md:order-none md:mt-8 md:gap-2">
						<span class="accent-figure text-[clamp(2rem,4vw,3.25rem)] leading-none">{fact.value}</span>
						<span class="font-heading text-base font-bold md:text-xl">{fact.unit}</span>
					</p>
					<p class="order-3 col-span-2 mt-2 leading-snug text-balance md:order-none md:mt-3 md:text-lg">{fact.text}</p>
					<p class="order-4 col-span-2 text-xs text-muted-foreground md:order-none md:mt-auto md:pt-6">
						Источник: <a
							class="underline underline-offset-4 hover:text-foreground"
							href={fact.href}
							rel="external noreferrer">{fact.source}</a
						>
					</p>
				</li>
			{/each}
		</ul>
	</div>
</section>

<style>
	.cell-on,
	.track-fill,
	.track-marker {
		transition:
			transform 0.5s var(--ease-standard),
			opacity 0.5s var(--ease-standard);
	}
	.cell-on {
		transition-delay: calc(var(--i) * 18ms);
	}
	.track-fill {
		transform-origin: left;
		transition-duration: 1.4s;
	}
	.track-marker {
		transition-delay: 1.1s;
	}
	[data-shown='false'] .cell-on {
		opacity: 0.15;
		transform: scale(0.4);
	}
	[data-shown='false'] .track-fill {
		transform: scaleX(0);
	}
	[data-shown='false'] .track-marker {
		opacity: 0;
		transform: scale(0.4);
	}
</style>
