// The callbacks of one screen through a scenario of the user: opening it, «Домой» and the way back, the screen lock,
// an `AlertDialog` of its own and a translucent activity of another app over it, «Назад», and for Junior `finish()`
// from `onCreate` and `onResume` and the system killing the process in the background. The answer is the log of the
// screen by the documented lifecycle (API 34); the independent Python planner of `_lib/lifecycle.ts` proves it.
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
	type LifecycleScenario
} from '../../_lib/lifecycle.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const SCREENS = ['OrderDetails', 'Profile', 'Chat', 'Article', 'Player', 'Settings', 'Cart', 'Ticket'];
const MAIN = 'Main';

/**
 * A piece of the scenario: `H` «Домой» and back, `L` the screen lock and unlock, `D` an `AlertDialog`, `O` a
 * translucent activity of another app, `R` «Назад» and opening the screen again, `N` the same but the screen is
 * first opened without an order number, `K` the background, the process killed and back from the recents.
 */
type Block = 'H' | 'L' | 'D' | 'O' | 'R' | 'N' | 'K';

const start = (screen: string, finishInCreate = false): LifecycleEvent => ({
	kind: 'start',
	screen,
	finishInCreate,
	finishCaller: false
});

function blockEvents(block: Block, screen: string): LifecycleEvent[] {
	switch (block) {
		case 'H':
			return [{ kind: 'home' }, { kind: 'return' }];
		case 'L':
			return [{ kind: 'lock' }, { kind: 'unlock' }];
		case 'D':
			return [{ kind: 'dialog' }];
		case 'O':
			return [{ kind: 'overlay' }];
		case 'R':
			return [{ kind: 'back' }, start(screen)];
		case 'N':
			return [{ kind: 'back' }, start(screen, true), start(screen)];
		case 'K':
			return [{ kind: 'home' }, { kind: 'kill' }, { kind: 'return' }];
	}
}

interface ClassPlan {
	pool: readonly Block[];
	mandatory: readonly Block[];
	count: [number, number];
	/** The last events: a tail chosen at random, `[]` included. */
	tails: readonly (readonly LifecycleEvent[])[];
	/** The screen is first opened without an order number (and closes itself), then with it. */
	firstWithoutId?: boolean;
	/** The screen finishes itself in `onResume` once the session has expired. */
	session?: boolean;
	required: readonly string[];
}

const TAILS: readonly (readonly LifecycleEvent[])[] = [[], [{ kind: 'home' }], [{ kind: 'back' }], [{ kind: 'lock' }]];

const PLANS: Record<string, ClassPlan> = {
	'intern/background': {
		pool: ['H', 'L', 'O', 'D', 'R'],
		mandatory: ['H'],
		count: [4, 4],
		tails: [[], [{ kind: 'back' }]],
		required: ['save-before-stop', 'no-restart']
	},
	'intern/overlay': {
		pool: ['H', 'O', 'R', 'L'],
		mandatory: ['D', 'O'],
		count: [4, 4],
		tails: [[], [{ kind: 'home' }]],
		required: ['dialog-pauses', 'translucent-stops']
	},
	'intern/back-reopen': {
		pool: ['H', 'O', 'R', 'D'],
		mandatory: ['R'],
		count: [3, 4],
		tails: [[{ kind: 'back' }]],
		required: ['back-saves']
	},
	'intern/lock': {
		pool: ['L', 'O', 'R', 'D'],
		mandatory: ['L'],
		count: [4, 4],
		tails: [[{ kind: 'lock' }]],
		required: ['save-before-stop']
	},
	'junior/finish-in-create': {
		pool: ['H', 'L', 'O', 'D', 'R', 'N'],
		mandatory: ['N'],
		count: [3, 4],
		tails: TAILS,
		firstWithoutId: true,
		required: ['finish-in-create-full']
	},
	'junior/finish-in-resume': {
		pool: ['H', 'L', 'O', 'D', 'R'],
		mandatory: [],
		count: [2, 3],
		tails: [
			[{ kind: 'home' }, { kind: 'expire' }, { kind: 'return' }],
			[{ kind: 'lock' }, { kind: 'expire' }, { kind: 'unlock' }],
			[{ kind: 'expire' }, { kind: 'dialog' }, { kind: 'overlay' }],
			[{ kind: 'expire' }, { kind: 'overlay' }]
		],
		session: true,
		required: ['finish-in-resume-direct']
	},
	'junior/process-death': {
		pool: ['H', 'L', 'O', 'D', 'K'],
		mandatory: ['K'],
		count: [3, 4],
		tails: TAILS,
		required: ['kill-calls-destroy', 'death-restarts']
	},
	'junior/death-and-close': {
		pool: ['H', 'L', 'O', 'D', 'R'],
		mandatory: ['K', 'R'],
		count: [3, 4],
		tails: [[{ kind: 'home' }], [{ kind: 'back' }], [{ kind: 'lock' }]],
		required: ['restore-before-start', 'back-saves']
	}
};

/** Blocks in random order; a `K` is followed by an `R` in the class that checks closing after a restore. */
function blocks(rng: Rng, plan: ClassPlan, classId: string): Block[] {
	const count = rng.int(plan.count[0], plan.count[1]);
	const picked: Block[] = [...plan.mandatory];
	while (picked.length < count) picked.push(rng.pick(plan.pool));
	const order = rng.shuffle(picked);
	if (classId === 'death-and-close') {
		// The restored screen is closed afterwards: some `R` comes after the `K`.
		const k = order.indexOf('K');
		const r = order.lastIndexOf('R');
		if (r < k) [order[k], order[r]] = ['R', 'K'];
	}
	return order;
}

function scenario(rng: Rng, grade: string, classId: string): LifecycleScenario {
	const plan = PLANS[`${grade}/${classId}`];
	if (!plan) throw new Error(`${descriptor.key}: no plan for ${grade}/${classId}`);
	const screen = rng.pick(SCREENS);
	const events: LifecycleEvent[] = [];
	if (plan.firstWithoutId && rng.bool()) events.push(start(screen, true));
	events.push(start(screen));
	for (const block of blocks(rng, plan, classId)) events.push(...blockEvents(block, screen));
	events.push(...rng.pick(plan.tails));
	return {
		screens: [
			{ name: MAIN, logged: false, translucent: false, configChanges: [], finishWhenExpired: false },
			{ name: screen, logged: true, translucent: false, configChanges: [], finishWhenExpired: plan.session === true }
		],
		initial: [MAIN],
		events,
		prefix: false
	};
}

function eventText(event: LifecycleEvent, screen: string, withIds: boolean): string {
	switch (event.kind) {
		case 'start':
			if (!withIds) return `Пользователь открывает \`${screen}\` с экрана \`${MAIN}\`.`;
			return event.finishInCreate
				? `Пользователь открывает \`${screen}\` с экрана \`${MAIN}\` по ссылке **без** номера заказа.`
				: `Пользователь открывает \`${screen}\` с экрана \`${MAIN}\` с номером заказа.`;
		case 'home':
			return 'Пользователь нажимает «Домой».';
		case 'return':
			return 'Пользователь возвращается в приложение из списка недавних.';
		case 'lock':
			return 'Пользователь нажимает кнопку питания — экран гаснет и блокируется.';
		case 'unlock':
			return 'Пользователь включает экран и снимает блокировку — приложение снова на экране.';
		case 'dialog':
			return `\`${screen}\` показывает \`AlertDialog\` («Удалить черновик?»), пользователь закрывает его кнопкой «Отмена».`;
		case 'overlay':
			return `Поверх \`${screen}\` открывается полупрозрачная Activity другого приложения (тема \`Theme.Translucent.NoTitleBar\`), пользователь закрывает её.`;
		case 'back':
			return 'Пользователь нажимает «Назад».';
		case 'kill':
			return 'Пока приложение в фоне, система завершает его процесс, чтобы освободить память.';
		case 'expire':
			return 'Сессия пользователя истекает (сама по себе это не вызывает колбэков).';
		case 'config':
			throw new Error(`${descriptor.key}: no configuration changes in this family`);
	}
}

function describe(s: LifecycleScenario, plan: ClassPlan): string {
	const screen = s.screens[1]?.name ?? '';
	const code: string[] = [];
	if (plan.firstWithoutId)
		code.push(
			`- В \`onCreate\` экран \`${screen}\` читает номер заказа из \`Intent\`; если номера нет, он вызывает \`finish()\` и сразу выходит из \`onCreate\`.`
		);
	if (plan.session)
		code.push(`- В \`onResume\` экран \`${screen}\` проверяет сессию; если она истекла, он вызывает \`finish()\`.`);
	return [
		`Ответ — по модели жизненного цикла Activity из документации Android для **API 34**, а не по поведению конкретного устройства.`,
		'',
		`Экран \`${screen}\` — Activity, которую открывают с главного экрана приложения \`${MAIN}\` (обе в одной задаче). \`${screen}\` не корневая: «Назад» закрывает её и возвращает на \`${MAIN}\`. Каждый колбэк \`${screen}\` первой строкой пишет в журнал своё имя; колбэки \`${MAIN}\` в журнал не попадают. Журналируются: \`onCreate\`, \`onStart\`, \`onRestart\`, \`onResume\`, \`onPause\`, \`onStop\`, \`onSaveInstanceState\`, \`onRestoreInstanceState\`, \`onDestroy\`.`,
		...(code.length ? ['', ...code] : []),
		'',
		'Что происходит по порядку:',
		'',
		...s.events.map((e, i) => `${i + 1}. ${eventText(e, screen, plan.firstWithoutId === true)}`),
		'',
		`Введите журнал экрана \`${screen}\` за весь сценарий: колбэки по порядку, по одному в строке, только имя метода (например, \`onCreate\`).`
	].join('\n');
}

const WRONG: Record<string, Partial<LifecycleRules>> = {
	'save-before-stop': { saveBeforeStop: true },
	'no-restart': { noRestart: true },
	'dialog-pauses': { dialogPauses: true },
	'translucent-stops': { translucentStops: true },
	'back-saves': { finishingSaves: true },
	'finish-in-create-full': { finishInCreateFull: true },
	'finish-in-resume-direct': { finishInResumeDirect: true },
	'kill-calls-destroy': { killCallsDestroy: true },
	'death-restarts': { deathRestarts: true },
	'restore-before-start': { restoreBeforeStart: true }
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const plan = PLANS[`${input.grade}/${input.classId}`];
	if (!plan) throw new Error(`${descriptor.key}: no plan for ${input.grade}/${input.classId}`);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class is about changes the log.
	for (let tries = 0; tries < 200; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const answer = lifecycleLog(s);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = lifecycleLog(s, { ...DOCUMENTED, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (plan.required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, plan), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: ACTIVITY_REFERENCE, stdin: activityReferenceInput(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
