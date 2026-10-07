<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { PATTERN_TILE, PATTERN_TILES, type PatternTone } from './pattern.js';

	/**
	 * The FSP pattern strip: decoration only, hidden from assistive technology. The height comes from `class`
	 * (`h-4`, `h-6`…). Without `tiles` the strip repeats to fill its width — a band under a heading or along an edge;
	 * with `tiles` (1–4) it shows that many tiles at their own proportions — an accent of an empty state or a card.
	 */
	let { class: className, tiles }: { class?: string; tiles?: number } = $props();

	const uid = $props.id();
	const tone: Record<PatternTone, string> = {
		blue: 'fill-brand-500',
		red: 'fill-brand-red',
		ink: 'fill-foreground'
	};
	const sequence = PATTERN_TILES.length * PATTERN_TILE.width;
	/** Repeats of the whole sequence a filling strip carries: wider than a 4K screen at the 12 px height. */
	const FILL_REPEATS = 10;
	/** Offsets of the copies that follow the drawn sequence. */
	const repeatOffsets = [...Array(FILL_REPEATS).keys()].slice(1).map((repeat) => repeat * sequence);

	const shown = $derived(tiles === undefined ? null : Math.min(PATTERN_TILES.length, Math.max(1, Math.round(tiles))));
	const width = $derived(shown === null ? sequence * FILL_REPEATS : shown * PATTERN_TILE.width);
</script>

<svg
	class={cn('block shrink-0', shown === null && 'w-full', className)}
	style:aspect-ratio={shown === null ? undefined : `${width} / ${PATTERN_TILE.height}`}
	viewBox="0 0 {width} {PATTERN_TILE.height}"
	preserveAspectRatio={shown === null ? 'xMinYMid slice' : 'xMinYMid meet'}
	aria-hidden="true"
	focusable="false"
	xmlns="http://www.w3.org/2000/svg"
>
	<g id="{uid}-sequence">
		{#each PATTERN_TILES as glyphs, index (index)}
			{#if shown === null || index < shown}
				<g transform="translate({index * PATTERN_TILE.width} 0)">
					{#each glyphs as glyph, glyphIndex (glyphIndex)}
						<path class={tone[glyph.tone]} d={glyph.d} fill-rule="evenodd" clip-rule="evenodd" />
					{/each}
				</g>
			{/if}
		{/each}
	</g>
	{#if shown === null}
		{#each repeatOffsets as offset (offset)}
			<use href="#{uid}-sequence" x={offset} />
		{/each}
	{/if}
</svg>
