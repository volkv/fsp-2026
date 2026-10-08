// Two and three screens of one task: when `A` starts `B`, `A` is paused first, `B` comes up to `onResume`, and only
// then `A` is stopped and saves its state — unless `B` is translucent, then `A` stays paused. «Назад» pauses the top
// screen, brings the one below back (`onRestart` after a stop) and only then stops and destroys the top. Junior adds
// `finish()` right after `startActivity` and chains of three screens. The independent Python planner of
// `_lib/lifecycle.ts` proves the log.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import {
	ACTIVITY_REFERENCE,
	activityReferenceInput,
	DOCUMENTED,
	lifecycleLog,
	type LifecycleEvent,
	type LifecycleRules,
	type LifecycleScenario,
	type ScreenSpec
} from '../../_lib/lifecycle.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const OPAQUE = ['Catalog', 'Product', 'Cart', 'Checkout', 'Profile', 'Orders', 'Chat', 'Search', 'Map', 'Feed'];
const TRANSLUCENT = ['Filters', 'DatePicker', 'Rating', 'ShareSheet', 'Confirm'];

/**
 * What the next step may be at a given stack, by class:
 * - `open` — the top starts a new screen (`translucent` from the class's rule), `finishCaller` from the class's rule;
 * - `back` — «Назад» on a stack of two or more; `home` — «Домой» and the way back (an opaque top only).
 */
type Step = 'open' | 'back' | 'home';

interface Rule {
	steps: [number, number];
	maxDepth: number;
	/** Whether the screen opened from a stack of `depth` screens is translucent. */
	translucentAt: (depth: number, rng: Rng) => boolean;
	/** Whether the caller at `depth` finishes itself right after `startActivity`. */
	finishAt: (depth: number, rng: Rng) => boolean;
	/** Which steps the class takes at a stack of `depth` screens; every step by default. */
	allowed?: (step: Step, depth: number) => boolean;
	/** What every scenario of the class must contain. */
	must: (log: readonly StepRecord[]) => boolean;
	required: readonly string[];
}

interface StepRecord {
	step: Step;
	depth: number;
	translucent: boolean;
	finishCaller: boolean;
}

const never = (): boolean => false;

const RULES: Record<string, Rule> = {
	// Only forward: the caller stops after the new screen is up, and a screen two levels down gets no callbacks.
	'intern/open-opaque': {
		steps: [2, 2],
		maxDepth: 3,
		translucentAt: never,
		finishAt: never,
		allowed: (step, depth) => step === 'open' || (step === 'home' && depth === 1),
		must: (log) => log.some((r) => r.step === 'open'),
		required: ['stop-before-start']
	},
	'intern/translucent': {
		steps: [2, 3],
		maxDepth: 2,
		translucentAt: () => true,
		finishAt: never,
		must: (log) => log.some((r) => r.step === 'back'),
		required: ['translucent-stops']
	},
	'intern/back': {
		steps: [2, 3],
		maxDepth: 2,
		translucentAt: never,
		finishAt: never,
		must: (log) => log.some((r) => r.step === 'back'),
		required: ['destroy-before-reveal', 'no-restart']
	},
	'intern/home-on-top': {
		steps: [2, 3],
		maxDepth: 2,
		translucentAt: never,
		finishAt: never,
		must: (log) => log.some((r) => r.step === 'home' && r.depth === 2),
		required: ['save-before-stop']
	},
	'junior/finish-on-start': {
		steps: [3, 3],
		maxDepth: 3,
		translucentAt: never,
		finishAt: (depth, rng) => depth === 1 && rng.bool(0.8),
		must: (log) => log.some((r) => r.finishCaller) && log.some((r) => r.step === 'back'),
		required: ['finish-ignored', 'finishing-saves']
	},
	'junior/chain': {
		steps: [3, 3],
		maxDepth: 3,
		translucentAt: never,
		finishAt: never,
		must: (log) => log.some((r) => r.step === 'back' && r.depth === 3),
		required: ['destroy-before-reveal']
	},
	'junior/translucent-chain': {
		steps: [4, 4],
		maxDepth: 3,
		translucentAt: (depth) => depth === 2,
		finishAt: never,
		must: (log) =>
			log.some((r) => r.step === 'back' && r.depth === 3) && log.some((r) => r.step === 'back' && r.depth === 2),
		required: ['translucent-stops']
	},
	'junior/finish-middle': {
		steps: [3, 3],
		maxDepth: 3,
		translucentAt: never,
		finishAt: (depth) => depth === 2,
		must: (log) =>
			log.some((r) => r.finishCaller) &&
			log.some((r, i) => r.step === 'back' && log.slice(0, i).some((p) => p.finishCaller)),
		required: ['finish-ignored']
	}
};

interface Draft {
	scenario: LifecycleScenario;
	texts: string[];
}

function draft(rng: Rng, rule: Rule): Draft | null {
	const opaque = rng.shuffle(OPAQUE);
	const translucent = rng.shuffle(TRANSLUCENT);
	const screens: ScreenSpec[] = [];
	const add = (isTranslucent: boolean): string => {
		const name = (isTranslucent ? translucent : opaque).pop();
		if (!name) throw new Error(`${descriptor.key}: out of screen names`);
		screens.push({ name, logged: true, translucent: isTranslucent, configChanges: [], finishWhenExpired: false });
		return name;
	};
	const root = add(false);
	const stack: { name: string; translucent: boolean }[] = [{ name: root, translucent: false }];
	const events: LifecycleEvent[] = [{ kind: 'start', screen: root, finishInCreate: false, finishCaller: false }];
	const texts = [`Пользователь запускает приложение, открывается \`${root}\`.`];
	const log: StepRecord[] = [];
	const steps = rng.int(rule.steps[0], rule.steps[1]);
	for (let i = 0; i < steps; i += 1) {
		const top = stack[stack.length - 1];
		if (!top) throw new Error(`${descriptor.key}: empty stack`);
		const options: Step[] = [];
		if (!top.translucent && stack.length < rule.maxDepth) options.push('open', 'open');
		if (stack.length >= 2) options.push('back');
		if (!top.translucent) options.push('home');
		const depth = stack.length;
		const allowed = options.filter((o) => rule.allowed?.(o, depth) ?? true);
		if (allowed.length === 0) return null;
		const step = rng.pick(allowed);
		if (step === 'open') {
			const isTranslucent = rule.translucentAt(depth, rng);
			const finishCaller = !isTranslucent && rule.finishAt(depth, rng);
			const name = add(isTranslucent);
			events.push({ kind: 'start', screen: name, finishInCreate: false, finishCaller });
			texts.push(
				finishCaller
					? `\`${top.name}\` открывает \`${name}\` (\`startActivity\`) и сразу после этого вызывает \`finish()\`.`
					: `\`${top.name}\` открывает \`${name}\` (\`startActivity\`).`
			);
			if (finishCaller) stack.pop();
			stack.push({ name, translucent: isTranslucent });
			log.push({ step, depth, translucent: isTranslucent, finishCaller });
		} else if (step === 'back') {
			events.push({ kind: 'back' });
			texts.push(`Пользователь нажимает «Назад» на \`${top.name}\`.`);
			stack.pop();
			log.push({ step, depth, translucent: top.translucent, finishCaller: false });
		} else {
			events.push({ kind: 'home' }, { kind: 'return' });
			texts.push('Пользователь нажимает «Домой».', 'Пользователь возвращается в приложение из списка недавних.');
			log.push({ step, depth, translucent: false, finishCaller: false });
		}
	}
	if (!rule.must(log)) return null;
	return { scenario: { screens, initial: [], events, prefix: true }, texts };
}

function describe(d: Draft): string {
	const kinds = d.scenario.screens.map((s) =>
		s.translucent
			? `- \`${s.name}\` — Activity с темой-диалогом (\`Theme.Material.Dialog\`): небольшое окно поверх, экран под ним остаётся виден;`
			: `- \`${s.name}\` — обычная полноэкранная Activity;`
	);
	kinds.push(`${kinds.pop()?.slice(0, -1) ?? ''}.`);
	return [
		'Ответ — по модели жизненного цикла Activity из документации Android для **API 34** (приложение собрано с `targetSdkVersion 34`), а не по поведению конкретного устройства.',
		'',
		'Экраны приложения (все в одной задаче, режим запуска — `standard`, каждый `startActivity` создаёт новый экземпляр):',
		'',
		...kinds,
		'',
		'Каждый колбэк каждого экрана первой строкой пишет в общий журнал `Экран.колбэк`. Журналируются: `onCreate`, `onStart`, `onRestart`, `onResume`, `onPause`, `onStop`, `onSaveInstanceState`, `onRestoreInstanceState`, `onDestroy`.',
		'',
		'Что происходит по порядку:',
		'',
		...d.texts.map((t, i) => `${i + 1}. ${t}`),
		'',
		`Введите общий журнал за весь сценарий: записи по порядку, по одной в строке, в виде \`Экран.колбэк\` (например, \`${d.scenario.screens[0]?.name ?? 'Main'}.onCreate\`).`
	].join('\n');
}

const WRONG: Record<string, Partial<LifecycleRules>> = {
	'stop-before-start': { stopBeforeStart: true },
	'translucent-stops': { translucentStops: true },
	'destroy-before-reveal': { destroyBeforeReveal: true },
	'no-restart': { noRestart: true },
	'save-before-stop': { saveBeforeStop: true },
	'finishing-saves': { finishingSaves: true },
	'finish-ignored': { finishIgnored: true }
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rule = RULES[`${input.grade}/${input.classId}`];
	if (!rule) throw new Error(`${descriptor.key}: no rule for ${input.grade}/${input.classId}`);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until the class's shape is there and every misconception it is about changes the log.
	for (let tries = 0; tries < 500; tries += 1) {
		const d = draft(rng, rule);
		if (!d) continue;
		const answer = lifecycleLog(d.scenario);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = lifecycleLog(d.scenario, { ...DOCUMENTED, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (rule.required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(d), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: ACTIVITY_REFERENCE, stdin: activityReferenceInput(d.scenario) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
