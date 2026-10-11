<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import AudiencePanel from './audience-panel.svelte';
	import { AUDIENCES as audiences, type Audience } from './content.js';

	/**
	 * The audiences one after another, with a pinned vertical switch beside them: scrolling past an audience lights its
	 * switch, choosing a switch scrolls to its audience. Each audience block carries its anchor of the public navigation.
	 */
	let active = $state<Audience['id']>('employers');
	let blocks: Record<string, HTMLElement> = $state({});

	$effect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const found = audiences.find((audience) => audience.id === entry.target.id);
					if (found) active = found.id;
				}
			},
			{ rootMargin: '-45% 0px -45% 0px' }
		);
		for (const block of Object.values(blocks)) observer.observe(block);
		return () => {
			observer.disconnect();
		};
	});

	function choose(event: MouseEvent, id: Audience['id']): void {
		const block = blocks[id];
		if (!block) return;
		event.preventDefault();
		const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		block.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
	}

	const activeIndex = $derived(audiences.findIndex((audience) => audience.id === active));
</script>

<section class="overflow-x-clip bg-background" aria-labelledby="audiences-title">
	<div class="mx-auto grid max-w-7xl gap-10 px-4 py-28 sm:px-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16 lg:py-36">
		<div class="lg:sticky lg:top-[calc(var(--header-height)+4rem)] lg:self-start">
			<p class="font-mono text-label text-link uppercase">Для кого</p>
			<h2
				id="audiences-title"
				class="mt-4 text-[clamp(1.6rem,3vw,2.6rem)] leading-[1.02] font-bold tracking-[-0.04em] text-balance"
			>
				Польза для каждой стороны найма
			</h2>
			<nav class="relative mt-10 hidden lg:block" aria-label="Для кого">
				<span class="absolute top-0 bottom-0 left-[1.1875rem] w-px bg-border" aria-hidden="true"></span>
				<span
					class="absolute top-0 left-[1.1875rem] w-px bg-primary transition-[height] duration-500 ease-standard"
					style:height="{((activeIndex + 1) / audiences.length) * 100}%"
					aria-hidden="true"
				></span>
				<ol class="relative space-y-2">
					{#each audiences as audience (audience.id)}
						<li>
							<a
								href="#{audience.id}"
								onclick={(event) => {
									choose(event, audience.id);
								}}
								aria-current={audience.id === active ? 'true' : undefined}
								class={cn(
									'flex items-center gap-4 rounded-xl py-2.5 pr-3 text-base font-medium transition-colors duration-300',
									audience.id === active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
								)}
							>
								<span
									class={cn(
										'flex size-10 shrink-0 items-center justify-center rounded-full border transition-all duration-300',
										audience.id === active
											? 'scale-110 border-primary bg-primary text-primary-foreground shadow-[0_0_0_6px_rgb(64_47_255/0.15)]'
											: 'bg-card'
									)}
								>
									<audience.icon class="size-4" aria-hidden="true" />
								</span>
								{audience.title}
							</a>
						</li>
					{/each}
				</ol>
			</nav>
		</div>

		<div>
			{#each audiences as audience, index (audience.id)}
				<div
					id={audience.id}
					bind:this={blocks[audience.id]}
					class={cn('flex scroll-mt-28 items-center py-16 lg:min-h-[80vh]', index > 0 && 'border-t')}
				>
					<AudiencePanel {audience} headingId="audience-{audience.id}-title" class="w-full" />
				</div>
			{/each}
		</div>
	</div>
</section>
