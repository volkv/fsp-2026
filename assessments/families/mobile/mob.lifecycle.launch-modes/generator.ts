// The back stack of one task under launch modes and intent flags: which activities stay in the task after a series of
// launches and Back presses, and which existing instances receive onNewIntent. One task affinity, one task; only the
// cases the Android documentation (Tasks and the back stack, Intent flags) states unambiguously.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Mode = 'standard' | 'singleTop' | 'singleTask';

type Step = { kind: 'start'; target: string; clearTop: boolean; singleTop: boolean } | { kind: 'back' };

interface Scenario {
	modes: Record<string, Mode>;
	names: string[];
	stack: string[];
	steps: Step[];
}

interface Rules {
	singleTopAnywhere: boolean;
	singleTaskReorder: boolean;
	clearTopReusesStandard: boolean;
	clearTopRecreatesAlways: boolean;
	reuseRecreates: boolean;
}

const RIGHT: Rules = {
	singleTopAnywhere: false,
	singleTaskReorder: false,
	clearTopReusesStandard: false,
	clearTopRecreatesAlways: false,
	reuseRecreates: false
};

const NAMES = [
	'Main',
	'Catalog',
	'Product',
	'Cart',
	'Checkout',
	'Profile',
	'Settings',
	'Search',
	'Orders',
	'Chat',
	'Feed',
	'Details',
	'Map',
	'Wallet'
] as const;

/** `null` — the scenario leaves the documented ground (two instances of a cleared-to activity). */
function simulate(s: Scenario, rules: Rules): string | null {
	const stack = [...s.stack];
	const newIntents: string[] = [];
	const reuse = (index: number): void => {
		const name = stack[index] ?? '';
		stack.length = index + 1;
		if (!rules.reuseRecreates) newIntents.push(name);
	};
	for (const step of s.steps) {
		if (step.kind === 'back') {
			// Back on the root activity is out of the model (Android 12+ moves the task to the background).
			if (stack.length < 2) return null;
			stack.pop();
			continue;
		}
		const { target } = step;
		const mode = s.modes[target] ?? 'standard';
		const positions = stack.flatMap((name, i) => (name === target ? [i] : []));
		const top = stack.length - 1;
		if (step.clearTop || mode === 'singleTask') {
			if (positions.length > 1) return null;
			const at = positions[0];
			if (at === undefined) {
				stack.push(target);
				continue;
			}
			if (mode === 'singleTask' && !step.clearTop && rules.singleTaskReorder) {
				stack.splice(at, 1);
				stack.push(target);
				if (!rules.reuseRecreates) newIntents.push(target);
				continue;
			}
			const keeps = mode !== 'standard' || step.singleTop;
			const reused = step.clearTop
				? rules.clearTopRecreatesAlways
					? false
					: keeps || rules.clearTopReusesStandard
				: true;
			if (reused) reuse(at);
			else stack.length = at + 1;
			continue;
		}
		if (mode === 'singleTop' || step.singleTop) {
			if (stack[top] === target) {
				reuse(top);
				continue;
			}
			const below = positions.at(-1);
			if (rules.singleTopAnywhere && below !== undefined) {
				reuse(below);
				continue;
			}
		}
		stack.push(target);
	}
	return `${stack.join(' ')} | ${newIntents.length ? newIntents.join(' ') : '-'}`;
}

function scenario(rng: Rng, classId: string): Scenario {
	const names = rng.sample(NAMES, 5);
	const [root, a, b, c, d] = names as [string, string, string, string, string];
	const modes: Record<string, Mode> = Object.fromEntries(names.map((name) => [name, 'standard']));
	if (classId === 'single-top') {
		modes[a] = 'singleTop';
		modes[b] = rng.pick(['singleTop', 'standard'] as const);
	} else if (classId === 'single-task') {
		modes[a] = 'singleTask';
		modes[b] = rng.pick(['singleTop', 'standard'] as const);
	} else if (classId === 'clear-top') {
		modes[b] = rng.pick(['singleTop', 'standard'] as const);
	} else {
		modes[a] = 'singleTop';
	}
	const others = [a, b, c, d];
	const stack = [root, ...rng.sample(others, rng.int(1, 3))];
	const steps: Step[] = [];
	const count = rng.int(4, 6);
	for (let i = 0; i < count; i += 1) {
		if (i > 0 && rng.bool(0.2)) {
			steps.push({ kind: 'back' });
			continue;
		}
		const target = rng.pick(rng.bool(0.7) ? [a, b] : [root, c, d]);
		const flags =
			classId === 'clear-top'
				? rng.pick([
						[true, false],
						[true, false],
						[false, false],
						[false, true]
					] as const)
				: classId === 'clear-top-single-top'
					? rng.pick([
							[true, true],
							[true, false],
							[false, true],
							[false, false]
						] as const)
					: classId === 'single-top'
						? rng.pick([
								[false, false],
								[false, false],
								[false, true]
							] as const)
						: ([false, false] as const);
		const singleTask = modes[target] === 'singleTask';
		steps.push({ kind: 'start', target, clearTop: !singleTask && flags[0], singleTop: !singleTask && flags[1] });
	}
	return { modes, names, stack, steps };
}

function flagText(step: Extract<Step, { kind: 'start' }>): string {
	const flags = [
		...(step.clearTop ? ['FLAG_ACTIVITY_CLEAR_TOP'] : []),
		...(step.singleTop ? ['FLAG_ACTIVITY_SINGLE_TOP'] : [])
	];
	return flags.length ? ` с флагами \`${flags.join(' or ')}\`` : ' без флагов';
}

function describe(s: Scenario): string {
	const table = s.names.map((name) => `| ${name} | \`${s.modes[name]}\` |`);
	const steps = s.steps.map((step, i) =>
		step.kind === 'back'
			? `${i + 1}. Пользователь нажимает «Назад» (верхняя активность закрывается).`
			: `${i + 1}. Верхняя активность запускает \`${step.target}\`${flagText(step)}.`
	);
	return [
		'По модели стека задач Android из документации (Tasks and the back stack; не на устройстве): все активности приложения — в одной задаче с одним `taskAffinity`; активность называется по имени класса без суффикса `Activity`. Если в задаче нет экземпляра `singleTask`-активности, новый экземпляр кладётся на вершину этой же задачи.',
		'',
		'Режимы запуска в манифесте:',
		'',
		'| Активность | `android:launchMode` |',
		'| --- | --- |',
		...table,
		'',
		`Стек задачи сейчас (снизу вверх): ${s.stack.join(' → ')}. Затем по очереди:`,
		'',
		...steps,
		'',
		'Введите итоговый стек снизу вверх через пробел, затем `|`, затем через пробел — какие существующие экземпляры получили `onNewIntent()`, в порядке вызовов (никакие — `-`). Например: `Main Feed Chat | Feed`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

s = json.loads(input())
modes = s["modes"]
stack = list(s["stack"])
got = []
for st in s["steps"]:
    if st["kind"] == "back":
        stack = stack[:-1]
        continue
    t = st["target"]
    m = modes[t]
    if st["clearTop"] or m == "singleTask":
        if t in stack:
            i = stack.index(t)
            stack = stack[: i + 1]
            if m != "standard" or st["singleTop"]:
                got.append(t)
            # a standard activity without SINGLE_TOP is finished and launched anew in the same place
        else:
            stack.append(t)
    elif (m == "singleTop" or st["singleTop"]) and stack and stack[-1] == t:
        got.append(t)
    else:
        stack.append(t)
print(" ".join(stack) + " | " + (" ".join(got) if got else "-"))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'single-top-anywhere': { singleTopAnywhere: true },
	'single-task-reorder': { singleTaskReorder: true },
	'clear-top-reuses-standard': { clearTopReusesStandard: true },
	'clear-top-recreates-always': { clearTopRecreatesAlways: true },
	'reuse-recreates': { reuseRecreates: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'single-top': ['single-top-anywhere', 'reuse-recreates'],
	'single-task': ['single-task-reorder'],
	'clear-top': ['clear-top-reuses-standard'],
	'clear-top-single-top': ['clear-top-recreates-always']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.classId);
		const answer = simulate(s, RIGHT);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(s, { ...RIGHT, ...change });
				return [id, value === null || value === answer ? null : value];
			})
		);
		if ((REQUIRED[input.classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
