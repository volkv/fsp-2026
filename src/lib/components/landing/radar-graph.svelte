<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { radarScene, type Palette, type Stage } from './radar-scene.js';

	/**
	 * The first screen's living graph told as hiring — the radar of `radar-scene` — drawn on a canvas that fills its
	 * positioned parent. It starts once the page has loaded and runs only while on screen. Decoration only, hidden
	 * from assistive technology; colours come from the theme tokens of the place it is drawn in; with reduced motion
	 * a single settled frame is drawn.
	 */
	let { class: className }: { class?: string } = $props();

	let canvas: HTMLCanvasElement | undefined = $state();

	$effect(() => {
		if (!canvas) return;
		const element: HTMLCanvasElement = canvas;
		const found = element.getContext('2d');
		if (!found) return;
		const context = found;
		/** Frames closer than this are skipped: a 120 Hz screen draws the drift no smoother, only twice as often. */
		const FRAME_MS = 1000 / 61;

		const style = getComputedStyle(element);
		const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
		const colors: Palette = {
			soft: token('--color-brand-300', '#8c84ff'),
			red: token('--brand-red', '#ec1d35'),
			ink: token('--foreground', '#ededed'),
			// The brand has no pink; a light rose between the FSP red and white.
			pink: '#ff86bd',
			green: token('--success', '#2bd483')
		};
		const stage: Stage = {
			ctx: context,
			width: 0,
			height: 0,
			dpr: 1,
			colors,
			pointer: { x: 0, y: 0, inside: false },
			taps: []
		};
		let current = radarScene(stage);

		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		let start = performance.now();
		let last = start;
		let frameId = 0;
		/** The scene starts once the page has loaded, so it does not compete with the first paint. */
		let started = false;
		/** The loop runs only while the canvas is on screen. */
		let onScreen = true;

		function clear(): void {
			context.setTransform(stage.dpr, 0, 0, stage.dpr, 0, 0);
			context.globalAlpha = 1;
			context.clearRect(0, 0, stage.width, stage.height);
		}

		function render(now: number): void {
			frameId = requestAnimationFrame(render);
			if (now - last < FRAME_MS) return;
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			clear();
			current.frame(dt, (now - start) / 1000);
			stage.taps.length = 0;
		}

		function run(): void {
			if (reduceMotion || !started || !onScreen || frameId !== 0) return;
			last = performance.now();
			frameId = requestAnimationFrame(render);
		}

		function pause(): void {
			cancelAnimationFrame(frameId);
			frameId = 0;
		}

		/** With reduced motion the scene runs a few seconds unseen, so the still frame shows matches, not a start. */
		function still(): void {
			for (let i = 0; i < 160; i++) {
				clear();
				current.frame(0.05, i * 0.05);
			}
		}

		function resize(): void {
			const rect = element.getBoundingClientRect();
			stage.width = rect.width;
			stage.height = rect.height;
			stage.dpr = Math.min(1.5, window.devicePixelRatio || 1);
			element.width = Math.round(stage.width * stage.dpr);
			element.height = Math.round(stage.height * stage.dpr);
			current = radarScene(stage);
			start = performance.now();
			if (reduceMotion && started) still();
		}

		const observer = new ResizeObserver(resize);
		observer.observe(element);
		resize();

		const visibility = new IntersectionObserver(([entry]) => {
			onScreen = entry?.isIntersecting ?? true;
			if (onScreen) run();
			else pause();
		});
		visibility.observe(element);

		let delay = 0;
		const begin = () => {
			delay = window.setTimeout(() => {
				started = true;
				resize();
				run();
			}, 250);
		};
		if (document.readyState === 'complete') begin();
		else window.addEventListener('load', begin, { once: true });

		const onMove = (event: PointerEvent) => {
			const rect = element.getBoundingClientRect();
			const { pointer } = stage;
			pointer.x = event.clientX - rect.left;
			pointer.y = event.clientY - rect.top;
			pointer.inside = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= rect.width && pointer.y <= rect.height;
		};
		/** A click on the empty first screen, not on its links and buttons, goes to the scene. */
		const onClick = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Element && target.closest('a, button, input, textarea, select, label, [role="group"]'))
				return;
			const rect = element.getBoundingClientRect();
			const x = event.clientX - rect.left;
			const y = event.clientY - rect.top;
			if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height) stage.taps.push({ x, y });
		};
		if (!reduceMotion) {
			window.addEventListener('pointermove', onMove);
			window.addEventListener('click', onClick);
		}

		return () => {
			pause();
			window.clearTimeout(delay);
			window.removeEventListener('load', begin);
			observer.disconnect();
			visibility.disconnect();
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('click', onClick);
		};
	});
</script>

<canvas bind:this={canvas} class={cn('pointer-events-none absolute inset-0 size-full', className)} aria-hidden="true"
></canvas>
