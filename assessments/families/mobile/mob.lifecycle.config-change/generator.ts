// Changes of the configuration of a screen in the foreground: without `android:configChanges` the screen is recreated
// (onPause, onStop, onSaveInstanceState, onDestroy, then onCreate, onStart, onRestoreInstanceState, onResume); when
// every changed qualifier is declared, only `onConfigurationChanged` is called; one undeclared qualifier is enough to
// recreate. Junior mixes rotation, a keyboard, the dark theme, the language, the size of a split-screen window and
// the system killing the process. The independent Python planner of `_lib/lifecycle.ts` proves the log.
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
	manifestValue,
	type LifecycleEvent,
	type LifecycleRules,
	type LifecycleScenario
} from '../../_lib/lifecycle.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const SCREENS = ['Editor', 'Player', 'Map', 'Chat', 'Camera', 'Reader', 'Checkout', 'Gallery'];

/** A change of the configuration as the statement tells it, with the qualifiers it changes. */
interface Change {
	text: string;
	changes: readonly string[];
}

const ROTATE: Change = { text: 'Пользователь поворачивает телефон', changes: ['orientation', 'screenSize'] };
const KEYBOARD: Change = {
	text: 'Пользователь подключает Bluetooth-клавиатуру',
	changes: ['keyboard', 'keyboardHidden']
};
const THEME: Change = { text: 'Пользователь переключает тёмную тему в шторке быстрых настроек', changes: ['uiMode'] };
const RESIZE: Change = {
	text: 'Пользователь перетаскивает разделитель экрана, окно приложения становится шире',
	changes: ['screenSize', 'smallestScreenSize', 'screenLayout']
};
const RESIZE_TURN: Change = {
	text: 'Пользователь перетаскивает разделитель экрана, окно приложения из вертикального становится горизонтальным',
	changes: ['orientation', 'screenSize', 'smallestScreenSize', 'screenLayout']
};

const LANGUAGES: Record<string, { name: string; rtl: boolean }> = {
	ru: { name: 'русский', rtl: false },
	en: { name: 'английский', rtl: false },
	de: { name: 'немецкий', rtl: false },
	ar: { name: 'арабский', rtl: true },
	he: { name: 'иврит', rtl: true }
};

/** A piece of the scenario: a change of the configuration, `H` «Домой» and back, `O` a translucent activity over the screen, `D` an `AlertDialog`, `K` the process killed in the background. */
type Block = Change | 'H' | 'O' | 'D' | 'K';

interface Plan {
	declared: readonly string[];
	blocks: Block[];
	/** The last event must be the change at this place of `blocks` (moved to the end). */
	lastChange?: 'handled' | 'recreated';
}

function blockEvents(block: Block): { event: LifecycleEvent; text: string }[] {
	if (block === 'H')
		return [
			{ event: { kind: 'home' }, text: 'Пользователь нажимает «Домой».' },
			{ event: { kind: 'return' }, text: 'Пользователь возвращается в приложение из списка недавних.' }
		];
	if (block === 'O')
		return [
			{
				event: { kind: 'overlay' },
				text: 'Поверх экрана открывается полупрозрачная Activity другого приложения (тема `Theme.Translucent.NoTitleBar`), пользователь закрывает её.'
			}
		];
	if (block === 'D')
		return [{ event: { kind: 'dialog' }, text: 'Экран показывает `AlertDialog`, пользователь закрывает его.' }];
	if (block === 'K')
		return [
			{ event: { kind: 'home' }, text: 'Пользователь нажимает «Домой».' },
			{
				event: { kind: 'kill' },
				text: 'Пока приложение в фоне, система завершает его процесс, чтобы освободить память.'
			},
			{ event: { kind: 'return' }, text: 'Пользователь возвращается в приложение из списка недавних.' }
		];
	return [
		{
			event: { kind: 'config', changes: block.changes },
			text: `${block.text} (меняются квалификаторы: ${block.changes.map((q) => `\`${q}\``).join(', ')}).`
		}
	];
}

const handledBy = (declared: readonly string[], change: Change): boolean =>
	change.changes.every((q) => declared.includes(q));

const isChange = (b: Block): b is Change => typeof b === 'object';

function fill<T>(rng: Rng, mandatory: readonly T[], pool: readonly T[], count: number): T[] {
	const blocks = [...mandatory];
	while (blocks.length < count) blocks.push(rng.pick(pool));
	return rng.shuffle(blocks);
}

/** A language change from the current language; it changes `layoutDirection` too when the direction flips. */
function languageChange(rng: Rng, current: { lang: string }): Change {
	const from = LANGUAGES[current.lang];
	const to = rng.pick(Object.keys(LANGUAGES).filter((l) => l !== current.lang));
	const target = LANGUAGES[to];
	if (!from || !target) throw new Error(`${descriptor.key}: unknown language`);
	current.lang = to;
	return {
		text: `Пользователь выбирает в меню экрана язык «${target.name}», приложение применяет его через \`LocaleManager.setApplicationLocales\``,
		changes: from.rtl === target.rtl ? ['locale'] : ['locale', 'layoutDirection']
	};
}

function plan(rng: Rng, grade: string, classId: string): Plan {
	const key = `${grade}/${classId}`;
	switch (key) {
		case 'intern/recreate':
			return { declared: [], blocks: fill<Block>(rng, [ROTATE], [ROTATE, 'H', 'O', 'D'], 4) };
		case 'intern/declared': {
			const declared = rng.bool()
				? ['orientation', 'screenSize', 'keyboard', 'keyboardHidden']
				: ['orientation', 'screenSize', 'screenLayout', 'keyboard', 'keyboardHidden'];
			return { declared, blocks: fill<Block>(rng, [ROTATE], [ROTATE, KEYBOARD, 'H', 'O', 'D'], 4) };
		}
		case 'intern/undeclared': {
			const other = rng.pick([THEME, KEYBOARD]);
			return {
				declared: ['orientation', 'screenSize'],
				blocks: fill<Block>(rng, [ROTATE, other], [ROTATE, other, 'H', 'O', 'D'], 4),
				lastChange: 'handled'
			};
		}
		case 'intern/orientation-only': {
			return {
				declared: rng.bool()
					? ['orientation', 'keyboard', 'keyboardHidden']
					: ['orientation', 'keyboard', 'keyboardHidden', 'uiMode'],
				blocks: fill<Block>(rng, [ROTATE, KEYBOARD], [ROTATE, KEYBOARD, 'H', 'O', 'D'], 4),
				lastChange: 'recreated'
			};
		}
		case 'junior/mixed-declared': {
			const all = [
				'orientation',
				'screenSize',
				'screenLayout',
				'smallestScreenSize',
				'keyboard',
				'keyboardHidden',
				'uiMode'
			];
			const declared = all.filter(() => rng.bool(0.55));
			const changes = [ROTATE, KEYBOARD, THEME, RESIZE];
			return { declared, blocks: fill<Block>(rng, rng.sample<Block>(changes, 3), [...changes, 'H', 'O'], 4) };
		}
		case 'junior/locale-theme': {
			const declared = rng.pick([
				['locale'],
				['locale', 'uiMode'],
				['locale', 'layoutDirection'],
				['uiMode', 'locale', 'layoutDirection']
			]);
			const shape = fill<'L' | 'T' | 'H' | 'O'>(rng, ['L', 'L', 'T'], ['L', 'T', 'H', 'O'], 4);
			const current = { lang: 'ru' };
			const blocks: Block[] = shape.map((s) => (s === 'L' ? languageChange(rng, current) : s === 'T' ? THEME : s));
			return { declared, blocks };
		}
		case 'junior/multi-window': {
			const declared = rng.pick([
				['screenSize', 'smallestScreenSize', 'screenLayout'],
				['screenSize', 'smallestScreenSize', 'screenLayout', 'orientation'],
				['screenSize', 'screenLayout', 'orientation'],
				['screenSize', 'smallestScreenSize', 'screenLayout', 'uiMode']
			]);
			return {
				declared,
				blocks: fill<Block>(rng, [RESIZE, RESIZE_TURN], [RESIZE, RESIZE_TURN, THEME, 'O', 'D'], rng.int(4, 5))
			};
		}
		case 'junior/process-death': {
			const declared = rng.bool() ? [] : ['orientation', 'screenSize'];
			return { declared, blocks: fill<Block>(rng, ['K', ROTATE], [ROTATE, THEME, 'H', 'O', 'K'], rng.int(3, 4)) };
		}
	}
	throw new Error(`${descriptor.key}: no plan for ${key}`);
}

interface Draft {
	scenario: LifecycleScenario;
	texts: string[];
	declared: readonly string[];
	screen: string;
}

function scenario(rng: Rng, grade: string, classId: string): Draft | null {
	const p = plan(rng, grade, classId);
	const blocks = [...p.blocks];
	if (p.lastChange) {
		const want = p.lastChange === 'handled';
		const at = blocks.findIndex((b) => isChange(b) && handledBy(p.declared, b) === want);
		if (at < 0) return null;
		blocks.push(...blocks.splice(at, 1));
	}
	const screen = rng.pick(SCREENS);
	const events: LifecycleEvent[] = [{ kind: 'start', screen, finishInCreate: false, finishCaller: false }];
	const texts = [`Пользователь запускает приложение, открывается \`${screen}\`.`];
	for (const block of blocks) {
		for (const { event, text } of blockEvents(block)) {
			events.push(event);
			texts.push(text);
		}
	}
	return {
		scenario: {
			screens: [
				{ name: screen, logged: true, translucent: false, configChanges: p.declared, finishWhenExpired: false }
			],
			initial: [],
			events,
			prefix: false
		},
		texts,
		declared: p.declared,
		screen
	};
}

function describe(b: Draft): string {
	const manifest = b.declared.length
		? [
				'```xml',
				'<activity',
				`    android:name=".${b.screen}Activity"`,
				`    android:configChanges="${manifestValue(b.declared)}" />`,
				'```'
			]
		: ['```xml', `<activity android:name=".${b.screen}Activity" />`, '```'];
	return [
		'Ответ — по модели жизненного цикла Activity из документации Android для **API 34** (приложение собрано с `targetSdkVersion 34`), а не по поведению конкретного устройства.',
		'',
		`Экран \`${b.screen}\` — единственная Activity приложения. Её объявление в манифесте:`,
		'',
		...manifest,
		'',
		`Каждый колбэк \`${b.screen}\` первой строкой пишет в журнал своё имя. Журналируются: \`onCreate\`, \`onStart\`, \`onRestart\`, \`onResume\`, \`onPause\`, \`onStop\`, \`onSaveInstanceState\`, \`onRestoreInstanceState\`, \`onDestroy\`, \`onConfigurationChanged\`. Все изменения конфигурации происходят, пока экран на переднем плане; в скобках — полный список квалификаторов, которые меняет событие.`,
		'',
		'Что происходит по порядку:',
		'',
		...b.texts.map((t, i) => `${i + 1}. ${t}`),
		'',
		`Введите журнал экрана \`${b.screen}\` за весь сценарий: колбэки по порядку, по одному в строке, только имя метода (например, \`onCreate\`).`
	].join('\n');
}

const WRONG: Record<string, Partial<LifecycleRules>> = {
	'save-before-stop': { saveBeforeStop: true },
	'no-restore': { noRestore: true },
	'restore-before-start': { restoreBeforeStart: true },
	'declared-ignored': { declaredIgnored: true },
	'any-declared': { anyDeclared: true },
	'kill-calls-destroy': { killCallsDestroy: true },
	'death-restarts': { deathRestarts: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/recreate': ['restore-before-start'],
	'intern/declared': ['declared-ignored'],
	'intern/undeclared': ['declared-ignored', 'no-restore'],
	'intern/orientation-only': ['any-declared'],
	'junior/mixed-declared': ['any-declared', 'declared-ignored'],
	'junior/locale-theme': ['any-declared'],
	'junior/multi-window': ['declared-ignored'],
	'junior/process-death': ['kill-calls-destroy', 'death-restarts']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Scenarios are drawn until every misconception the class is about changes the log.
	for (let tries = 0; tries < 200; tries += 1) {
		const b = scenario(rng, input.grade, input.classId);
		if (!b) continue;
		const answer = lifecycleLog(b.scenario);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = lifecycleLog(b.scenario, { ...DOCUMENTED, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(b), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: ACTIVITY_REFERENCE, stdin: activityReferenceInput(b.scenario) }),
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
