<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { reducedMotion, visibleElement, waitForElement } from '$lib/onboarding/dom.js';
	import { tour } from '$lib/onboarding/tour.svelte.js';

	/**
	 * The stop of a running tour: a frame around the element and a card next to it. Neither stands in the way of the
	 * page: the frame passes every pointer event through, and the dimming around it is the frame's own shadow, so the
	 * framed element and everything else stay clickable and editable. The card is a plain region, not a modal dialog:
	 * it takes the focus once when the tour starts and never traps it; its keys work only while it holds the focus.
	 */

	const step = $derived(tour.current);
	const last = $derived(tour.index + 1 === tour.steps.length);

	type Box = { left: number; top: number; width: number; height: number };

	/** Where the framed element is on the screen; `null` — no element, the card stands in the middle. */
	let rect = $state<Box | null>(null);
	/**
	 * The person scrolls the page: the frame and the card follow the element frame by frame, without gliding behind
	 * it. Between stops they glide — straight to where the element will stand once the tour has scrolled to it.
	 */
	let scrolling = $state(false);
	/** Lower edge of the sticky header: nothing of the tour hides under it. */
	let headerBottom = $state(0);
	let width = $state(0);
	let height = $state(0);
	let card: HTMLElement | undefined = $state();
	let cardHeight = $state(0);
	/** The card fades in once its place is known, and glides between the stops only after that. */
	let shown = $state(false);
	let glide = $state(false);

	const GAP = 14;
	const MARGIN = 16;
	const FRAME = 6;
	/** How far the card reaches past the edge of a wide framed block, so it does not merge with it. */
	const OVERHANG = 40;
	/** Longest smooth scroll the tour waits for before measuring again, for browsers without `scrollend`. */
	const SCROLL_WAIT = 1500;

	function measureHeader(): number {
		const header = document.querySelector('header[data-rows]');
		return header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
	}

	const boxOf = (element: HTMLElement, shift = 0): Box => {
		const box = element.getBoundingClientRect();
		return { left: box.left, top: box.top - shift, width: box.width, height: box.height };
	};

	function reveal(): void {
		if (!shown) {
			shown = true;
			requestAnimationFrame(() => {
				glide = true;
			});
		}
	}

	// A new tour starts hidden: its card appears where it belongs instead of jumping there.
	$effect(() => {
		if (tour.run >= 0) {
			shown = false;
			glide = false;
		}
	});

	$effect(() => {
		const current = step;
		// A new page of the main tour renders a new element under the same mark: look again after every navigation.
		if (current === null || !page.url.pathname.startsWith('/')) {
			rect = null;
			return;
		}
		const controller = new AbortController();
		let element: HTMLElement | null = null;
		/** The tour itself is scrolling the page to the element: the frame already stands at the end of the way. */
		let travelling = false;
		let frame = 0;
		let settle = 0;
		let arrival = 0;

		const measure = (): void => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				headerBottom = measureHeader();
				rect = element?.isConnected ? boxOf(element) : null;
				reveal();
			});
		};
		const arrive = (): void => {
			if (!travelling) return;
			travelling = false;
			clearTimeout(arrival);
			measure();
		};
		const scroll = (): void => {
			if (travelling) return;
			scrolling = true;
			clearTimeout(settle);
			settle = window.setTimeout(() => {
				scrolling = false;
			}, 150);
			measure();
		};
		const resize = new ResizeObserver(() => {
			if (!travelling) measure();
		});

		void (async () => {
			let found = current.target === null ? null : await waitForElement(current.target, 3000, controller.signal);
			// On a narrow screen the sections hide in the menu: the stop of a section frames the title of its page.
			if (found === null && current.href !== null) found = visibleElement('#content h1');
			if (controller.signal.aborted) return;
			element = found;
			if (found === null) {
				measure();
				return;
			}
			resize.observe(found);
			const shift = scrollFor(found);
			if (shift === 0) {
				measure();
				return;
			}
			// The frame and the card glide to where the element will be, while the page scrolls under them.
			headerBottom = measureHeader();
			rect = boxOf(found, shift);
			reveal();
			const smooth = !reducedMotion();
			travelling = smooth;
			window.scrollBy({ top: shift, behavior: smooth ? 'smooth' : 'auto' });
			if (smooth) arrival = window.setTimeout(arrive, SCROLL_WAIT);
			else measure();
		})();

		window.addEventListener('scroll', scroll, { capture: true, passive: true });
		window.addEventListener('scrollend', arrive, { passive: true });
		window.addEventListener('resize', measure, { passive: true });
		return () => {
			controller.abort();
			cancelAnimationFrame(frame);
			clearTimeout(settle);
			clearTimeout(arrival);
			resize.disconnect();
			window.removeEventListener('scroll', scroll, { capture: true });
			window.removeEventListener('scrollend', arrive);
			window.removeEventListener('resize', measure);
		};
	});

	/**
	 * How far to scroll so the element shows by its top edge, just under the header, instead of in the middle: a tall
	 * block then starts where the eye looks and runs down the page, and the card keeps its place next to it. An element
	 * already in view with room for the card, or one in the header itself, needs no scroll. The distance is cut to what
	 * the page can actually scroll, so the frame aims at where the element really ends up.
	 */
	function scrollFor(element: HTMLElement): number {
		if (element.closest('header[data-rows]')) return 0;
		const box = element.getBoundingClientRect();
		const top = measureHeader() + MARGIN + FRAME;
		const room = (cardHeight || 200) + GAP + MARGIN;
		if (box.top >= top && box.bottom + room <= window.innerHeight) return 0;
		const wanted = box.top - top - MARGIN;
		const max = document.documentElement.scrollHeight - window.innerHeight;
		return Math.round(Math.min(Math.max(window.scrollY + wanted, 0), max) - window.scrollY);
	}

	// The card takes the focus once per tour, so keyboard users land in it; later stops leave the focus where it is.
	$effect(() => {
		if (tour.run > 0 && card) card.focus({ preventScroll: true });
	});

	/** Narrow screens dock the card to the bottom edge, or under the header when the framed element is down there. */
	const docked = $derived(width < 640);
	const cardWidth = $derived(Math.min(360, width - 2 * MARGIN));

	const position = $derived.by(() => {
		const own = cardHeight || 200;
		const ceiling = headerBottom + MARGIN;
		if (docked) {
			const low = rect !== null && rect.top + rect.height > height - own - 2 * MARGIN;
			return low
				? `top: ${ceiling}px; left: ${MARGIN}px; right: ${MARGIN}px;`
				: `bottom: ${MARGIN}px; left: ${MARGIN}px; right: ${MARGIN}px;`;
		}
		if (rect === null) {
			return `top: ${Math.max(ceiling, (height - own) / 2)}px; left: ${(width - cardWidth) / 2}px; width: ${cardWidth}px;`;
		}
		const frameTop = rect.top - FRAME;
		const frameBottom = rect.top + rect.height + FRAME;
		const frameLeft = rect.left - FRAME;
		const frameRight = rect.left + rect.width + FRAME;
		const clampLeft = (value: number): number => Math.min(Math.max(value, MARGIN), width - cardWidth - MARGIN);
		const clampTop = (value: number): number => Math.min(Math.max(value, ceiling), height - own - MARGIN);
		// A wide block: the card reaches past its right edge (or left, when the screen ends there).
		const wide = rect.width > cardWidth;
		let left = wide ? frameRight - cardWidth + OVERHANG : frameLeft;
		if (wide && left + cardWidth > width - MARGIN) left = frameLeft - OVERHANG;

		if (frameBottom + GAP + own <= height - MARGIN) {
			return `top: ${frameBottom + GAP}px; left: ${clampLeft(left)}px; width: ${cardWidth}px;`;
		}
		if (frameTop - GAP - own >= ceiling) {
			return `top: ${frameTop - GAP - own}px; left: ${clampLeft(left)}px; width: ${cardWidth}px;`;
		}
		// A block taller than the screen: the card stands beside it when there is room, else over its top corner.
		const top = clampTop(Math.max(frameTop, ceiling) + MARGIN);
		if (width - frameRight >= cardWidth + GAP + MARGIN) {
			return `top: ${top}px; left: ${frameRight + GAP}px; width: ${cardWidth}px;`;
		}
		if (frameLeft >= cardWidth + GAP + MARGIN) {
			return `top: ${top}px; left: ${frameLeft - GAP - cardWidth}px; width: ${cardWidth}px;`;
		}
		return `top: ${top}px; left: ${clampLeft(left)}px; width: ${cardWidth}px;`;
	});

	/** Keys of the tour work only while the focus is in the card: typing in the page never turns the stops. */
	function keys(event: KeyboardEvent): void {
		if (!card || !(event.target instanceof Node) || !card.contains(event.target)) return;
		if (event.key === 'Escape') tour.close();
		else if (event.key === 'ArrowRight') tour.next();
		else if (event.key === 'ArrowLeft') tour.back();
		else return;
		event.preventDefault();
	}
</script>

<svelte:window bind:innerWidth={width} bind:innerHeight={height} onkeydown={keys} />

{#if step}
	{#if rect}
		<div
			class={[
				'pointer-events-none fixed z-50 animate-in rounded-lg ring-2 ring-primary duration-300 fade-in-0',
				!scrolling && 'motion-safe:transition-[left,top,width,height] motion-safe:duration-300 motion-safe:ease-out'
			]}
			style="left: {rect.left - FRAME}px; top: {rect.top - FRAME}px; width: {rect.width +
				2 * FRAME}px; height: {rect.height + 2 * FRAME}px; box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.32);"
			aria-hidden="true"
			data-testid="tour-frame"
		></div>
	{/if}
	<div
		bind:this={card}
		bind:offsetHeight={cardHeight}
		role="region"
		aria-labelledby="tour-step-title"
		tabindex="-1"
		class={[
			'fixed z-50 grid gap-3 rounded-xl bg-[color-mix(in_oklch,var(--primary)_80%,white)] p-4 text-primary-foreground shadow-[0_24px_64px_-12px_rgb(0_0_0/0.4)] ring-4 ring-primary/20 outline-none focus-visible:ring-primary-foreground/60',
			glide && !scrolling
				? 'motion-safe:transition-[opacity,scale,top,left,bottom] motion-safe:duration-300 motion-safe:ease-out'
				: 'motion-safe:transition-[opacity,scale] motion-safe:duration-300',
			shown ? 'scale-100 opacity-100' : 'pointer-events-none scale-95 opacity-0'
		]}
		style={position}
		data-testid="tour-card"
	>
		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-primary-foreground/75">
				{tour.title} · {tour.index + 1} из {tour.steps.length}
			</p>
			<Button
				variant="ghost"
				size="icon-xs"
				class="text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"
				aria-label="Закрыть тур"
				onclick={() => {
					tour.close();
				}}
			>
				<XIcon aria-hidden="true" />
			</Button>
		</div>
		<div class="grid gap-1" aria-live="polite">
			<p id="tour-step-title" class="font-heading font-semibold text-balance">{step.title}</p>
			<p class="text-sm text-primary-foreground/90">{step.body}</p>
		</div>
		<div class="flex items-center justify-between gap-2">
			<Button
				variant="ghost"
				size="sm"
				class="text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"
				disabled={tour.index === 0}
				onclick={() => {
					tour.back();
				}}>Назад</Button
			>
			<Button
				variant="secondary"
				size="sm"
				onclick={() => {
					tour.next();
				}}>{last ? 'Готово' : 'Далее'}</Button
			>
		</div>
	</div>
{/if}
