<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { PATTERN_TILE, PATTERN_TILES, type PatternTone } from './pattern.js';

	/**
	 * A living background of FSP pattern glyphs: the glyphs drift as nodes of a graph, nearby ones are linked, red
	 * pulses run along the links and light up the node they reach, and the graph leans towards the pointer. Decoration
	 * only, hidden from assistive technology; fills its positioned parent. Colours come from the theme tokens of the
	 * place it is drawn in; with reduced motion a single still frame is drawn.
	 */
	let { class: className }: { class?: string } = $props();

	interface Glyph {
		path: Path2D;
		tone: PatternTone;
		/** Centre of the glyph in its tile's box. */
		cx: number;
		cy: number;
	}

	interface Node {
		x: number;
		y: number;
		vx: number;
		vy: number;
		glyph: Glyph;
		/** Glow after a pulse arrived, 1 → 0. */
		flash: number;
	}

	interface Pulse {
		from: Node;
		to: Node;
		progress: number;
	}

	const SVG_NS = 'http://www.w3.org/2000/svg';
	/** Nodes closer than this are linked, CSS px. */
	const REACH = 170;
	/** Radius of the pointer's pull and of its links, CSS px. */
	const POINTER_REACH = 200;
	const GLYPH_SIZE = 18;

	let canvas: HTMLCanvasElement | undefined = $state();

	function at<T>(list: readonly T[], index: number): T {
		const item = list[index];
		if (item === undefined) throw new RangeError(`No item at ${String(index)}`);
		return item;
	}

	const rand = (min: number, max: number): number => min + Math.random() * (max - min);
	const randInt = (count: number): number => Math.floor(Math.random() * count);
	const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
	const easeInOut = (k: number): number => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

	/** Glyphs of the pattern with their centres; the browser measures the paths once per mount. */
	function measureGlyphs(): Glyph[] {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('width', '0');
		svg.setAttribute('height', '0');
		svg.style.position = 'absolute';
		svg.style.visibility = 'hidden';
		document.body.append(svg);
		const glyphs: Glyph[] = [];
		for (const tile of PATTERN_TILES) {
			for (const glyph of tile) {
				const node = document.createElementNS(SVG_NS, 'path');
				node.setAttribute('d', glyph.d);
				svg.append(node);
				const box = node.getBBox();
				glyphs.push({
					path: new Path2D(glyph.d),
					tone: glyph.tone,
					cx: box.x + box.width / 2,
					cy: box.y + box.height / 2
				});
			}
		}
		svg.remove();
		return glyphs;
	}

	$effect(() => {
		if (!canvas) return;
		const element: HTMLCanvasElement = canvas;
		const context = element.getContext('2d');
		if (!context) return;
		const ctx = context;

		const glyphs = measureGlyphs();
		const style = getComputedStyle(element);
		const colors: Record<PatternTone, string> = {
			blue: style.getPropertyValue('--primary').trim() || '#402fff',
			red: style.getPropertyValue('--brand-red').trim() || '#ec1d35',
			ink: style.getPropertyValue('--foreground').trim() || '#ededed'
		};
		const pointer = { x: 0, y: 0, inside: false };
		let width = 0;
		let height = 0;
		let dpr = 1;
		let nodes: Node[] = [];
		let pulses: Pulse[] = [];
		let nextPulse = 0;

		/** Draws a glyph centred at (x, y); `size` is the height of the tile row in CSS px. */
		function drawGlyph(glyph: Glyph, x: number, y: number, size: number, alpha: number): void {
			const scale = (size / PATTERN_TILE.height) * dpr;
			ctx.setTransform(scale, 0, 0, scale, x * dpr, y * dpr);
			ctx.translate(-glyph.cx, -glyph.cy);
			ctx.globalAlpha = Math.min(1, alpha);
			ctx.fillStyle = colors[glyph.tone];
			ctx.fill(glyph.path, 'evenodd');
		}

		function resetTransform(): void {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		function line(ax: number, ay: number, bx: number, by: number, alpha: number): void {
			ctx.globalAlpha = alpha;
			ctx.beginPath();
			ctx.moveTo(ax, ay);
			ctx.lineTo(bx, by);
			ctx.stroke();
		}

		function seed(): void {
			const count = clamp(Math.round((width * height) / 20000), 24, 80);
			nodes = Array.from({ length: count }, () => ({
				x: rand(0, width),
				y: rand(0, height),
				vx: rand(-14, 14),
				vy: rand(-10, 10),
				glyph: at(glyphs, randInt(glyphs.length)),
				flash: 0
			}));
			pulses = [];
		}

		function move(dt: number): void {
			for (const node of nodes) {
				node.x += node.vx * dt;
				node.y += node.vy * dt;
				if (pointer.inside) {
					const dx = pointer.x - node.x;
					const dy = pointer.y - node.y;
					const distance = Math.hypot(dx, dy);
					if (distance < POINTER_REACH + 20 && distance > 40) {
						node.x += (dx / distance) * 18 * dt;
						node.y += (dy / distance) * 18 * dt;
					}
				}
				if (node.x < -30) node.x = width + 30;
				if (node.x > width + 30) node.x = -30;
				if (node.y < -30) node.y = height + 30;
				if (node.y > height + 30) node.y = -30;
				node.flash = Math.max(0, node.flash - dt * 1.2);
			}
		}

		function drawLinks(): void {
			resetTransform();
			ctx.lineWidth = 1;
			ctx.strokeStyle = colors.blue;
			for (let i = 0; i < nodes.length; i++) {
				const a = at(nodes, i);
				for (let j = i + 1; j < nodes.length; j++) {
					const b = at(nodes, j);
					const distance = Math.hypot(a.x - b.x, a.y - b.y);
					if (distance > REACH) continue;
					line(a.x, a.y, b.x, b.y, (1 - distance / REACH) * 0.42 + Math.max(a.flash, b.flash) * 0.35);
				}
				if (pointer.inside) {
					const distance = Math.hypot(a.x - pointer.x, a.y - pointer.y);
					if (distance < POINTER_REACH) line(a.x, a.y, pointer.x, pointer.y, (1 - distance / POINTER_REACH) * 0.6);
				}
			}
		}

		function drawPulses(time: number, dt: number): void {
			if (time > nextPulse && nodes.length > 0) {
				nextPulse = time + rand(0.25, 0.7);
				const from = at(nodes, randInt(nodes.length));
				const neighbours = nodes.filter((n) => n !== from && Math.hypot(n.x - from.x, n.y - from.y) < REACH);
				if (neighbours.length > 0) pulses.push({ from, to: at(neighbours, randInt(neighbours.length)), progress: 0 });
			}
			resetTransform();
			ctx.fillStyle = colors.red;
			ctx.shadowColor = colors.red;
			ctx.shadowBlur = 10;
			ctx.globalAlpha = 0.9;
			pulses = pulses.filter((pulse) => {
				pulse.progress += dt / 1.1;
				if (pulse.progress >= 1) {
					pulse.to.flash = 1;
					return false;
				}
				const k = easeInOut(pulse.progress);
				ctx.beginPath();
				ctx.arc(
					pulse.from.x + (pulse.to.x - pulse.from.x) * k,
					pulse.from.y + (pulse.to.y - pulse.from.y) * k,
					2.4,
					0,
					Math.PI * 2
				);
				ctx.fill();
				return true;
			});
			ctx.shadowBlur = 0;
		}

		function drawNodes(): void {
			for (const node of nodes) {
				const near = pointer.inside
					? clamp(1 - Math.hypot(node.x - pointer.x, node.y - pointer.y) / POINTER_REACH, 0, 1)
					: 0;
				drawGlyph(node.glyph, node.x, node.y, GLYPH_SIZE + node.flash * 10, 0.45 + node.flash * 0.55 + near * 0.35);
			}
		}

		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const start = performance.now();
		let last = start;
		let frameId = 0;

		function render(now: number): void {
			const time = (now - start) / 1000;
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			resetTransform();
			ctx.globalAlpha = 1;
			ctx.clearRect(0, 0, width, height);
			move(dt);
			drawLinks();
			drawPulses(time, dt);
			drawNodes();
			if (!reduceMotion) frameId = requestAnimationFrame(render);
		}

		function resize(): void {
			const rect = element.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			dpr = Math.min(2, window.devicePixelRatio || 1);
			element.width = Math.round(width * dpr);
			element.height = Math.round(height * dpr);
			seed();
			if (reduceMotion) render(performance.now());
		}

		const observer = new ResizeObserver(resize);
		observer.observe(element);
		resize();
		if (!reduceMotion) frameId = requestAnimationFrame(render);

		const onMove = (event: PointerEvent) => {
			const rect = element.getBoundingClientRect();
			pointer.x = event.clientX - rect.left;
			pointer.y = event.clientY - rect.top;
			pointer.inside = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= rect.width && pointer.y <= rect.height;
		};
		if (!reduceMotion) window.addEventListener('pointermove', onMove);

		return () => {
			cancelAnimationFrame(frameId);
			observer.disconnect();
			window.removeEventListener('pointermove', onMove);
		};
	});
</script>

<canvas bind:this={canvas} class={cn('pointer-events-none absolute inset-0 size-full', className)} aria-hidden="true"
></canvas>
