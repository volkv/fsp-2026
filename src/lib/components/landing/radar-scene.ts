// The first screen's living graph, told as hiring: the employer writes first. Drifting people and briefcases are
// linked to their neighbours and lean towards the pointer, like the FSP pattern background. A briefcase sends a search
// wave, the candidates it touches pulse, a few get a thin red invitation; the keen turn pink and drift closer, the
// rest turn red and drift away; one gets the green line of an offer, accepts, and the two dissolve together. A click
// puts a briefcase under the pointer and starts a search from it. `RadarGraph` owns the canvas, its size, the pointer
// and the frame loop.

export interface Palette {
	/** A lighter logo blue that reads on the dark first screen: links, candidates. */
	soft: string;
	/** Logo red: the moment of a match. */
	red: string;
	/** The third colour, light on a dark surface: employers. */
	ink: string;
	/** A candidate who is interested. */
	pink: string;
	/** An offer, and the candidate who accepts it. */
	green: string;
}

export interface Pointer {
	x: number;
	y: number;
	inside: boolean;
}

export interface Stage {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	dpr: number;
	colors: Palette;
	pointer: Pointer;
	/** Clicks since the last frame, in canvas px; the host empties the list after each frame. */
	taps: { x: number; y: number }[];
}

export interface Scene {
	/** Advances the scene by `dt` seconds and draws it on a cleared canvas; `time` is seconds since the start. */
	frame(dt: number, time: number): void;
}

const TAU = Math.PI * 2;
/** Nodes closer than this are linked, CSS px. */
const REACH = 170;
/** Radius of the pointer's pull and of its links, CSS px. */
const POINTER_REACH = 200;

function at<T>(list: readonly T[], index: number): T {
	const item = list[index];
	if (item === undefined) throw new RangeError(`No item at ${index}`);
	return item;
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const randInt = (count: number): number => Math.floor(Math.random() * count);
const pick = <T>(list: readonly T[]): T => at(list, randInt(list.length));
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const easeOut = (k: number): number => 1 - (1 - k) ** 3;

interface Body {
	x: number;
	y: number;
	vx: number;
	vy: number;
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** How many nodes a scene of this size holds, as dense as the pattern background. */
const population = (stage: Stage, per = 20000, min = 24, max = 80): number =>
	clamp(Math.round((stage.width * stage.height) / per), min, max);

function body(stage: Stage, speed = 1): Body {
	return {
		x: rand(0, stage.width),
		y: rand(0, stage.height),
		vx: rand(-14, 14) * speed,
		vy: rand(-10, 10) * speed
	};
}

/** A point just outside a random edge, for nodes that enter the scene. */
function edgePoint(stage: Stage): { x: number; y: number } {
	const side = randInt(4);
	if (side === 0) return { x: -24, y: rand(0, stage.height) };
	if (side === 1) return { x: stage.width + 24, y: rand(0, stage.height) };
	if (side === 2) return { x: rand(0, stage.width), y: -24 };
	return { x: rand(0, stage.width), y: stage.height + 24 };
}

/** Drifts a body, leans it towards the pointer and wraps it around the edges. */
function drift(stage: Stage, node: Body, dt: number): void {
	node.x += node.vx * dt;
	node.y += node.vy * dt;
	const { pointer } = stage;
	if (pointer.inside) {
		const dx = pointer.x - node.x;
		const dy = pointer.y - node.y;
		const d = Math.hypot(dx, dy);
		if (d < POINTER_REACH + 20 && d > 40) {
			node.x += (dx / d) * 18 * dt;
			node.y += (dy / d) * 18 * dt;
		}
	}
	const margin = 30;
	if (node.x < -margin) node.x = stage.width + margin;
	if (node.x > stage.width + margin) node.x = -margin;
	if (node.y < -margin) node.y = stage.height + margin;
	if (node.y > stage.height + margin) node.y = -margin;
}

/** Moves a body towards a point at up to `speed` px/s, keeping a little of its own drift. */
function steer(node: Body, x: number, y: number, speed: number, dt: number): void {
	const dx = x - node.x;
	const dy = y - node.y;
	const d = Math.hypot(dx, dy);
	if (d < 0.5) return;
	const step = Math.min(d, speed * dt);
	node.x += (dx / d) * step;
	node.y += (dy / d) * step;
}

/** 0 → 1 as the pointer comes closer than `reach`. */
function nearPointer(stage: Stage, x: number, y: number, reach = POINTER_REACH): number {
	const { pointer } = stage;
	return pointer.inside ? clamp(1 - Math.hypot(x - pointer.x, y - pointer.y) / reach, 0, 1) : 0;
}

// ——— Drawing ———

function reset(stage: Stage): void {
	const { ctx, dpr } = stage;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.globalAlpha = 1;
	ctx.shadowBlur = 0;
	ctx.setLineDash([]);
	ctx.lineCap = 'butt';
	ctx.lineJoin = 'miter';
}

function line(stage: Stage, ax: number, ay: number, bx: number, by: number, alpha: number): void {
	const { ctx } = stage;
	ctx.globalAlpha = clamp(alpha, 0, 1);
	ctx.beginPath();
	ctx.moveTo(ax, ay);
	ctx.lineTo(bx, by);
	ctx.stroke();
}

function dot(stage: Stage, x: number, y: number, radius: number, color: string, alpha: number, glow = 0): void {
	const { ctx } = stage;
	ctx.fillStyle = color;
	// A halo instead of shadowBlur: a blurred shadow is the most expensive thing a 2D canvas can draw.
	if (glow > 0) {
		ctx.globalAlpha = clamp(alpha * 0.18, 0, 1);
		ctx.beginPath();
		ctx.arc(x, y, radius + glow * 0.45, 0, TAU);
		ctx.fill();
	}
	ctx.globalAlpha = clamp(alpha, 0, 1);
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, TAU);
	ctx.fill();
}

/** A node that may be fading in or out; links to it fade with it. */
type Faded = Body & { fade?: number };

/** Steps of a link's opacity: links of one step share one path and one stroke call instead of one call each. */
const LINK_STEPS = 24;

/** Strokes many links of one colour, `[ax, ay, bx, by, alpha]` each, with one call per opacity step. */
class LinkBatch {
	private readonly steps: number[][] = Array.from({ length: LINK_STEPS }, () => []);
	private readonly strength: number;

	constructor(strength: number) {
		this.strength = strength;
	}

	add(ax: number, ay: number, bx: number, by: number, alpha: number): void {
		if (alpha <= 0) return;
		const step = Math.min(LINK_STEPS - 1, Math.floor((alpha / this.strength) * LINK_STEPS));
		at(this.steps, step).push(ax, ay, bx, by);
	}

	stroke(stage: Stage, color: string): void {
		const { ctx } = stage;
		ctx.lineWidth = 1;
		ctx.strokeStyle = color;
		for (let step = 0; step < LINK_STEPS; step++) {
			const list = at(this.steps, step);
			if (list.length === 0) continue;
			ctx.globalAlpha = clamp(((step + 0.5) / LINK_STEPS) * this.strength, 0, 1);
			ctx.beginPath();
			for (let i = 0; i < list.length; i += 4) {
				ctx.moveTo(at(list, i), at(list, i + 1));
				ctx.lineTo(at(list, i + 2), at(list, i + 3));
			}
			ctx.stroke();
		}
	}
}

const visible = (node: Faded): number => clamp(node.fade ?? 1, 0, 1);

/** Faint links between every two nearby nodes: the network the scene happens in. */
function mesh(stage: Stage, nodes: readonly Faded[], color: string, strength: number, reach = REACH): void {
	const batch = new LinkBatch(strength);
	const reach2 = reach * reach;
	for (let i = 0; i < nodes.length; i++) {
		const a = at(nodes, i);
		const fadeA = visible(a);
		if (fadeA === 0) continue;
		for (let j = i + 1; j < nodes.length; j++) {
			const b = at(nodes, j);
			const dx = a.x - b.x;
			const dy = a.y - b.y;
			const d2 = dx * dx + dy * dy;
			if (d2 >= reach2) continue;
			const fade = Math.min(fadeA, visible(b));
			if (fade > 0) batch.add(a.x, a.y, b.x, b.y, (1 - Math.sqrt(d2) / reach) * strength * fade);
		}
	}
	batch.stroke(stage, color);
}

/** Links from the pointer to the nodes around it: whoever points is looking. */
function pointerLinks(stage: Stage, nodes: readonly Faded[], color: string, strength = 0.6): void {
	const { pointer } = stage;
	if (!pointer.inside) return;
	const batch = new LinkBatch(strength);
	for (const node of nodes) {
		const near = nearPointer(stage, node.x, node.y);
		if (near > 0) batch.add(node.x, node.y, pointer.x, pointer.y, near * strength * visible(node));
	}
	batch.stroke(stage, color);
}

/** A person: head and shoulders, `size` px tall, centred at (x, y). */
function person(stage: Stage, x: number, y: number, size: number, color: string, alpha: number): void {
	const { ctx } = stage;
	ctx.globalAlpha = clamp(alpha, 0, 1);
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(x, y - size * 0.24, size * 0.21, 0, TAU);
	ctx.moveTo(x - size * 0.4, y + size * 0.48);
	ctx.ellipse(x, y + size * 0.48, size * 0.4, size * 0.42, 0, Math.PI, TAU);
	ctx.closePath();
	ctx.fill();
}

/** A briefcase — an employer — `size` px wide, centred at (x, y). */
function briefcase(stage: Stage, x: number, y: number, size: number, color: string, alpha: number): void {
	const { ctx } = stage;
	const s = size;
	ctx.globalAlpha = clamp(alpha, 0, 1);
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.roundRect(x - s * 0.5, y - s * 0.22, s, s * 0.64, s * 0.1);
	ctx.rect(x - s * 0.5, y + s * 0.02, s, s * 0.06);
	ctx.roundRect(x - s * 0.2, y - s * 0.42, s * 0.4, s * 0.2, [s * 0.07, s * 0.07, 0, 0]);
	ctx.rect(x - s * 0.12, y - s * 0.34, s * 0.24, s * 0.12);
	ctx.fill('evenodd');
}

interface Burst {
	x: number;
	y: number;
	age: number;
	color: string;
	size: number;
}

/** Expanding rings where something met; returns the rings still alive. */
function bursts(stage: Stage, list: Burst[], dt: number, duration = 0.9): Burst[] {
	const { ctx } = stage;
	return list.filter((burst) => {
		burst.age += dt;
		const k = burst.age / duration;
		if (k >= 1) return false;
		ctx.strokeStyle = burst.color;
		ctx.lineWidth = 1.5 * (1 - k) + 0.5;
		ctx.globalAlpha = (1 - k) * 0.9;
		ctx.beginPath();
		ctx.arc(burst.x, burst.y, 4 + easeOut(k) * burst.size, 0, TAU);
		ctx.stroke();
		return true;
	});
}

export function radarScene(stage: Stage): Scene {
	type Mood = 'calm' | 'keen' | 'declined' | 'chosen';
	interface Agent extends Body {
		employer: boolean;
		/** Born from a click: leaves the scene once its search is over. */
		temporary: boolean;
		leaving: boolean;
		mood: Mood;
		/** The last mood that was not calm, for the colour while it fades back. */
		tone: Mood;
		/** 0 → 1: how much of the mood colour shows. */
		tint: number;
		/** Seconds before the node starts to fade in: the first frame fills up gradually, not all at once. */
		appear: number;
		calmIn: number;
		flash: number;
		fade: number;
		busy: boolean;
	}
	interface Invite {
		agent: Agent;
		start: number;
		grow: number;
		answerIn: number;
		answer: 'pending' | 'keen' | 'declined';
		fade: number;
	}
	interface Hunt {
		employer: Agent;
		phase: 'scan' | 'invite' | 'offer' | 'merge' | 'gone';
		radius: number;
		max: number;
		hits: Agent[];
		invites: Invite[];
		chosen: Agent | null;
		offer: number;
		timer: number;
	}
	interface Speck {
		x: number;
		y: number;
		vx: number;
		vy: number;
		life: number;
		color: string;
	}

	const { colors } = stage;
	const count = population(stage);
	const employers = clamp(Math.round(count / 10), 2, 6);
	const agents: Agent[] = Array.from({ length: count }, (_, i) => {
		const agent = newAgent(i < employers);
		agent.fade = 0;
		agent.appear = rand(0, 2.6);
		return agent;
	});
	let hunts: Hunt[] = [];
	let specks: Speck[] = [];
	let rings: Burst[] = [];
	let nextHunt = 4;

	function newAgent(employer: boolean, temporary = false): Agent {
		return {
			...body(stage, employer ? 0.5 : 1),
			employer,
			temporary,
			leaving: false,
			mood: 'calm',
			tone: 'calm',
			tint: 0,
			appear: 0,
			calmIn: 0,
			flash: 0,
			fade: 1,
			busy: false
		};
	}

	const moodColor = (mood: Mood): string =>
		mood === 'keen' ? colors.pink : mood === 'declined' ? colors.red : mood === 'chosen' ? colors.green : colors.soft;

	function setMood(agent: Agent, mood: Mood): void {
		agent.mood = mood;
		if (mood !== 'calm') agent.tone = mood;
		agent.flash = Math.max(agent.flash, 0.6);
	}

	function start(employer: Agent): void {
		employer.busy = true;
		employer.flash = 1;
		hunts.push({
			employer,
			phase: 'scan',
			radius: 0,
			max: rand(200, 250),
			hits: [],
			invites: [],
			chosen: null,
			offer: 0,
			timer: 0
		});
	}

	/** The pair met: a puff of specks, and both fade away to come back elsewhere. */
	function dissolve(hunt: Hunt, chosen: Agent): void {
		const x = (hunt.employer.x + chosen.x) / 2;
		const y = (hunt.employer.y + chosen.y) / 2;
		rings.push({ x, y, age: 0, color: colors.green, size: 44 });
		for (let i = 0; i < 28; i++) {
			const angle = rand(0, TAU);
			const speed = rand(25, 95);
			specks.push({
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				life: rand(0.7, 1.3),
				color: i % 3 === 0 ? colors.pink : colors.green
			});
		}
		hunt.phase = 'gone';
		hunt.timer = 0;
	}

	function release(agent: Agent, mood: Mood = 'calm'): void {
		agent.busy = false;
		agent.calmIn = mood === 'calm' ? 0 : rand(2, 3.2);
		if (mood === 'calm') agent.mood = 'calm';
	}

	function respawn(agent: Agent): void {
		const fresh = newAgent(agent.employer);
		const point = edgePoint(stage);
		Object.assign(agent, fresh, { x: point.x, y: point.y, fade: 0 });
		agent.vx = (stage.width / 2 - point.x) * rand(0.015, 0.03) + rand(-6, 6);
		agent.vy = (stage.height / 2 - point.y) * rand(0.015, 0.03) + rand(-6, 6);
	}

	function step(hunt: Hunt, dt: number): boolean {
		const { employer } = hunt;
		hunt.timer += dt;
		if (hunt.phase === 'scan') {
			hunt.radius += dt * 110;
			for (const agent of agents) {
				if (agent.employer || agent.busy || hunt.hits.includes(agent)) continue;
				if (Math.abs(distance(agent, employer) - hunt.radius) < 7) {
					hunt.hits.push(agent);
					agent.flash = 1;
				}
			}
			if (hunt.radius < hunt.max) return true;
			const invited = hunt.hits
				.filter((a) => !a.busy)
				.sort((a, b) => distance(a, employer) - distance(b, employer))
				.slice(0, 4);
			if (invited.length === 0) {
				release(employer);
				if (employer.temporary) employer.leaving = true;
				return false;
			}
			hunt.phase = 'invite';
			hunt.timer = 0;
			hunt.invites = invited.map((agent, index) => {
				agent.busy = true;
				return {
					agent,
					start: index * 0.18,
					grow: 0,
					answerIn: 1.3 + index * 0.4 + rand(0, 0.5),
					answer: 'pending',
					fade: 1
				};
			});
			return true;
		}

		if (hunt.phase === 'invite') {
			for (const invite of hunt.invites) {
				if (hunt.timer > invite.start) invite.grow = Math.min(1, invite.grow + dt / 0.6);
				if (invite.answer === 'pending' && hunt.timer > invite.start + invite.answerIn) {
					const pending = hunt.invites.filter((i) => i.answer === 'pending').length;
					const anyKeen = hunt.invites.some((i) => i.answer === 'keen');
					const keen = !anyKeen && pending === 1 ? true : Math.random() < 0.5;
					invite.answer = keen ? 'keen' : 'declined';
					setMood(invite.agent, invite.answer);
					if (!keen) {
						const d = Math.max(1, distance(invite.agent, employer));
						invite.agent.vx = ((invite.agent.x - employer.x) / d) * 55;
						invite.agent.vy = ((invite.agent.y - employer.y) / d) * 55;
						release(invite.agent, 'declined');
					}
				}
				if (invite.answer === 'declined') invite.fade = Math.max(0, invite.fade - dt * 1.5);
				if (invite.answer === 'keen') {
					const agent = invite.agent;
					const d = distance(agent, employer);
					if (d > 70) steer(agent, employer.x, employer.y, 14, dt);
				}
			}
			const last = Math.max(...hunt.invites.map((i) => i.start + i.answerIn));
			if (hunt.timer > last + 1.1) {
				const keen = hunt.invites.filter((i) => i.answer === 'keen');
				keen.sort((a, b) => distance(a.agent, employer) - distance(b.agent, employer));
				const chosen = keen[0]?.agent ?? null;
				for (const invite of keen) {
					if (invite.agent === chosen) continue;
					invite.answer = 'declined';
					release(invite.agent, 'keen');
				}
				if (!chosen) {
					release(employer);
					if (employer.temporary) employer.leaving = true;
					return false;
				}
				hunt.chosen = chosen;
				hunt.phase = 'offer';
				hunt.timer = 0;
			}
			return true;
		}

		const chosen = hunt.chosen;
		if (!chosen) return false;
		for (const invite of hunt.invites) {
			if (invite.agent !== chosen) invite.fade = Math.max(0, invite.fade - dt * 1.2);
		}

		if (hunt.phase === 'offer') {
			hunt.offer = Math.min(1, hunt.offer + dt / 0.9);
			if (hunt.offer >= 1 && chosen.mood !== 'chosen') {
				setMood(chosen, 'chosen');
				chosen.flash = 1;
			}
			if (hunt.timer > 1.6) {
				hunt.phase = 'merge';
				hunt.timer = 0;
			}
			return true;
		}

		if (hunt.phase === 'merge') {
			const mx = (employer.x + chosen.x) / 2;
			const my = (employer.y + chosen.y) / 2;
			const pull = Math.min(110, 20 + hunt.timer * 70);
			steer(employer, mx, my, pull, dt);
			steer(chosen, mx, my, pull, dt);
			if (distance(employer, chosen) < 10) dissolve(hunt, chosen);
			return true;
		}

		// Gone: both fade out together, then come back elsewhere as strangers.
		employer.fade = Math.max(0, employer.fade - dt * 2.2);
		chosen.fade = employer.fade;
		if (employer.fade > 0) return true;
		respawn(chosen);
		if (employer.temporary) employer.fade = -1;
		else respawn(employer);
		return false;
	}

	return {
		frame(dt, time) {
			for (const tap of stage.taps) {
				if (hunts.length >= 4) break;
				const employer = newAgent(true, true);
				Object.assign(employer, { x: tap.x, y: tap.y, vx: rand(-4, 4), vy: rand(-3, 3), fade: 0 });
				agents.push(employer);
				start(employer);
			}
			if (time > nextHunt && !hunts.some((h) => !h.employer.temporary)) {
				const ready = agents.filter((a) => a.employer && !a.temporary && !a.busy && a.fade >= 1);
				const inside = ready.filter((a) => a.x > 60 && a.x < stage.width - 60 && a.y > 60 && a.y < stage.height - 60);
				if (inside.length > 0) {
					start(pick(inside));
					nextHunt = time + rand(7, 11);
				}
			}

			for (const agent of agents) {
				const held = hunts.some(
					(h) => (h.phase === 'merge' || h.phase === 'gone') && (h.employer === agent || h.chosen === agent)
				);
				if (!held) drift(stage, agent, agent.busy && agent.employer ? dt * 0.3 : dt);
				// A declined candidate's push wears off back to an ordinary drift.
				const speed = Math.hypot(agent.vx, agent.vy);
				if (speed > 18) {
					agent.vx *= 1 - dt * 0.6;
					agent.vy *= 1 - dt * 0.6;
				}
				agent.flash = Math.max(0, agent.flash - dt * 1.1);
				if (agent.leaving) {
					agent.fade -= dt * 1.2;
					if (agent.fade <= 0) agent.fade = -1;
				} else if (agent.appear > 0) agent.appear -= dt;
				else if (agent.fade >= 0 && !held) agent.fade = Math.min(1, agent.fade + dt * 0.7);
				if (!agent.busy && agent.mood !== 'calm') {
					agent.calmIn -= dt;
					if (agent.calmIn <= 0) agent.mood = 'calm';
				}
				agent.tint = clamp(agent.tint + (agent.mood === 'calm' ? -dt * 0.8 : dt * 2.5), 0, 1);
			}
			hunts = hunts.filter((hunt) => step(hunt, dt));
			for (let i = agents.length - 1; i >= 0; i--) if (at(agents, i).fade < 0) agents.splice(i, 1);

			reset(stage);
			const { ctx } = stage;
			mesh(stage, agents, colors.soft, 0.16);
			pointerLinks(stage, agents, colors.soft, 0.3);

			for (const hunt of hunts) {
				const { employer } = hunt;
				if (hunt.phase === 'scan') {
					const k = hunt.radius / hunt.max;
					ctx.strokeStyle = colors.soft;
					ctx.lineWidth = 1;
					ctx.globalAlpha = (1 - k) * 0.35;
					ctx.beginPath();
					ctx.arc(employer.x, employer.y, hunt.radius, 0, TAU);
					ctx.stroke();
					ctx.globalAlpha = (1 - k) * 0.06;
					ctx.lineWidth = 10;
					ctx.beginPath();
					ctx.arc(employer.x, employer.y, Math.max(0, hunt.radius - 6), 0, TAU);
					ctx.stroke();
				}
				for (const invite of hunt.invites) {
					if (invite.grow <= 0 || invite.fade <= 0 || invite.agent === hunt.chosen) continue;
					const { agent } = invite;
					const k = easeOut(invite.grow);
					ctx.strokeStyle = invite.answer === 'keen' ? colors.pink : colors.red;
					ctx.lineWidth = 0.8;
					line(
						stage,
						employer.x,
						employer.y,
						lerp(employer.x, agent.x, k),
						lerp(employer.y, agent.y, k),
						0.45 * invite.fade
					);
					if (invite.grow < 1)
						dot(stage, lerp(employer.x, agent.x, k), lerp(employer.y, agent.y, k), 1.6, colors.red, 0.7, 6);
				}
				if (hunt.chosen && (hunt.phase === 'offer' || hunt.phase === 'merge')) {
					const k = easeOut(hunt.offer);
					const { chosen } = hunt;
					const ex = lerp(employer.x, chosen.x, k);
					const ey = lerp(employer.y, chosen.y, k);
					ctx.strokeStyle = colors.green;
					ctx.lineWidth = 5;
					line(stage, employer.x, employer.y, ex, ey, 0.1);
					ctx.lineWidth = 1.2;
					line(stage, employer.x, employer.y, ex, ey, 0.75);
					if (hunt.offer < 1)
						dot(stage, lerp(employer.x, chosen.x, k), lerp(employer.y, chosen.y, k), 2, colors.green, 0.9, 8);
				}
			}

			specks = specks.filter((speck) => {
				speck.life -= dt;
				speck.x += speck.vx * dt;
				speck.y += speck.vy * dt;
				speck.vx *= 1 - dt * 1.5;
				speck.vy *= 1 - dt * 1.5;
				if (speck.life <= 0) return false;
				dot(stage, speck.x, speck.y, 1.4, speck.color, Math.min(1, speck.life) * 0.8, 6);
				return true;
			});
			rings = bursts(stage, rings, dt, 1.1);

			for (const agent of agents) {
				const near = nearPointer(stage, agent.x, agent.y);
				const fade = clamp(agent.fade, 0, 1);
				if (agent.employer) {
					const lit = agent.busy ? 0.25 : 0;
					briefcase(
						stage,
						agent.x,
						agent.y,
						18 + agent.flash * 4,
						colors.ink,
						fade * (0.42 + lit + agent.flash * 0.3 + near * 0.25)
					);
					continue;
				}
				const size = 16 + agent.flash * 5;
				const alpha = fade * (0.36 + agent.flash * 0.4 + agent.tint * 0.3 + near * 0.3);
				if (agent.tint < 1) person(stage, agent.x, agent.y, size, colors.soft, alpha * (1 - agent.tint));
				if (agent.tint > 0) person(stage, agent.x, agent.y, size, moodColor(agent.tone), alpha * agent.tint);
			}
		}
	};
}
