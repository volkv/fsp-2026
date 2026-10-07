// The documented lifecycle of Android activities (API 34) as a model for the `mob.lifecycle` families: which callbacks
// a task of screens receives when the user opens and closes screens, sends the app to the background, changes the
// configuration or the system kills the process. The model is the platform's documentation, not a device: every rule
// below is stated in the guides «The activity lifecycle», «Handle configuration changes», «Tasks and the back stack»
// and «Save UI states». The families print a log of callbacks; the gate proves it with an independent Python program
// (`ACTIVITY_REFERENCE`) that plans transitions from the target state of every screen instead of handling events.

/** A screen (an activity class) of a scenario. */
export interface ScreenSpec {
	name: string;
	/** Whether its callbacks are written to the log the candidate reconstructs. */
	logged: boolean;
	/** A translucent or dialog theme: the screen below stays visible, so it is only paused. */
	translucent: boolean;
	/** `android:configChanges` of the manifest: the qualifiers the screen handles itself. */
	configChanges: readonly string[];
	/** `onResume` calls `finish()` once the session has expired. */
	finishWhenExpired: boolean;
}

/**
 * What happens to the task:
 * - `start` — the top screen starts `screen` (an empty task: the launcher starts it); `finishInCreate` — the new
 *   screen calls `finish()` in its `onCreate`; `finishCaller` — the caller calls `finish()` right after
 *   `startActivity`;
 * - `back` — «Назад» finishes the top screen (never the last one);
 * - `home`/`lock` — the task goes to the background (the screen turns off); `return`/`unlock` — back to the front;
 * - `dialog` — the top screen shows and dismisses an `AlertDialog` of its own;
 * - `overlay` — a translucent activity of another app opens over the top screen and is closed;
 * - `config` — the configuration changes while the top screen is in the foreground: the qualifiers in `changes`;
 * - `kill` — the system kills the process while the task is in the background;
 * - `expire` — the session expires (nothing is called).
 */
export type LifecycleEvent =
	| { kind: 'start'; screen: string; finishInCreate: boolean; finishCaller: boolean }
	| { kind: 'back' }
	| { kind: 'home' }
	| { kind: 'lock' }
	| { kind: 'return' }
	| { kind: 'unlock' }
	| { kind: 'dialog' }
	| { kind: 'overlay' }
	| { kind: 'config'; changes: readonly string[] }
	| { kind: 'kill' }
	| { kind: 'expire' };

/** A scenario: the screens, the stack before the first event (bottom first, the top resumed), the events. */
export interface LifecycleScenario {
	screens: readonly ScreenSpec[];
	initial: readonly string[];
	events: readonly LifecycleEvent[];
	/** Log lines as `Screen.onX` (several logged screens) or as `onX` (one). */
	prefix: boolean;
}

/** The misconceptions of the families, each a switch of the model; all off is the documented behaviour. */
export interface LifecycleRules {
	/** `onSaveInstanceState` before `onStop`, as before API 28. */
	saveBeforeStop: boolean;
	/** A stopped screen coming back skips `onRestart`. */
	noRestart: boolean;
	/** An `AlertDialog` of the screen pauses and resumes it. */
	dialogPauses: boolean;
	/** A screen under a translucent one is stopped (and restarted when it is uncovered). */
	translucentStops: boolean;
	/** A finishing screen also saves its state. */
	finishingSaves: boolean;
	/** `finish()` in `onCreate` still runs the screen up to `onResume` and down. */
	finishInCreateFull: boolean;
	/** `finish()` in `onResume` goes straight to `onDestroy`. */
	finishInResumeDirect: boolean;
	/** The killed process calls `onDestroy` of its screens. */
	killCallsDestroy: boolean;
	/** After the process was killed, the screen comes back through `onRestart`, as if its instance lived. */
	deathRestarts: boolean;
	/** A recreated screen gets no `onRestoreInstanceState`. */
	noRestore: boolean;
	/** `onRestoreInstanceState` right after `onCreate`, before `onStart`. */
	restoreBeforeStart: boolean;
	/** `android:configChanges` is ignored: every change recreates the screen. */
	declaredIgnored: boolean;
	/** A change is handled if any of its qualifiers is declared (not all of them). */
	anyDeclared: boolean;
	/** The caller is paused and stopped before the started screen is created. */
	stopBeforeStart: boolean;
	/** «Назад»: the top screen is stopped and destroyed before the screen below comes back. */
	destroyBeforeReveal: boolean;
	/** `finish()` right after `startActivity` is ignored: the caller stays in the stack. */
	finishIgnored: boolean;
}

export const DOCUMENTED: LifecycleRules = {
	saveBeforeStop: false,
	noRestart: false,
	dialogPauses: false,
	translucentStops: false,
	finishingSaves: false,
	finishInCreateFull: false,
	finishInResumeDirect: false,
	killCallsDestroy: false,
	deathRestarts: false,
	noRestore: false,
	restoreBeforeStart: false,
	declaredIgnored: false,
	anyDeclared: false,
	stopBeforeStart: false,
	destroyBeforeReveal: false,
	finishIgnored: false
};

type State = 'resumed' | 'paused' | 'stopped' | 'dead';

interface Instance {
	spec: ScreenSpec;
	state: State;
}

/** The log of callbacks the scenario produces under the rules; an event the scenario cannot have is an error. */
export function lifecycleLog(scenario: LifecycleScenario, rules: LifecycleRules = DOCUMENTED): string[] {
	const specs = new Map(scenario.screens.map((s) => [s.name, s]));
	const specOf = (name: string): ScreenSpec => {
		const spec = specs.get(name);
		if (!spec) throw new Error(`lifecycle: unknown screen ${name}`);
		return spec;
	};
	const stack: Instance[] = scenario.initial.map((name, i, all) => ({
		spec: specOf(name),
		state: i === all.length - 1 ? 'resumed' : 'stopped'
	}));
	const out: string[] = [];
	let foreground = true;
	let expired = false;

	const log = (i: Instance, callback: string): void => {
		if (i.spec.logged) out.push(scenario.prefix ? `${i.spec.name}.${callback}` : callback);
	};
	const top = (): Instance => {
		const t = stack[stack.length - 1];
		if (!t) throw new Error('lifecycle: empty stack');
		return t;
	};
	const pause = (i: Instance): void => {
		if (i.state !== 'resumed') throw new Error(`lifecycle: pausing ${i.spec.name} in ${i.state}`);
		log(i, 'onPause');
		i.state = 'paused';
	};
	const stop = (i: Instance, finishing: boolean): void => {
		const save = !finishing || rules.finishingSaves;
		if (save && rules.saveBeforeStop) log(i, 'onSaveInstanceState');
		log(i, 'onStop');
		if (save && !rules.saveBeforeStop) log(i, 'onSaveInstanceState');
		i.state = 'stopped';
	};
	const remove = (i: Instance): void => {
		const at = stack.indexOf(i);
		if (at >= 0) stack.splice(at, 1);
	};
	/** A new instance from saved state: after a recreation or a killed process. */
	const recreate = (i: Instance): void => {
		log(i, 'onCreate');
		if (rules.restoreBeforeStart && !rules.noRestore) log(i, 'onRestoreInstanceState');
		log(i, 'onStart');
		if (!rules.restoreBeforeStart && !rules.noRestore) log(i, 'onRestoreInstanceState');
		resume(i);
	};
	const resume = (i: Instance): void => {
		log(i, 'onResume');
		i.state = 'resumed';
		if (i.spec.finishWhenExpired && expired) {
			remove(i);
			if (rules.finishInResumeDirect) {
				log(i, 'onDestroy');
				return;
			}
			pause(i);
			if (stack.length) reveal(top());
			stop(i, true);
			log(i, 'onDestroy');
		}
	};
	/** The screen becomes the resumed top again. */
	const reveal = (i: Instance): void => {
		switch (i.state) {
			case 'resumed':
				return;
			case 'paused':
				resume(i);
				return;
			case 'stopped':
				if (!rules.noRestart) log(i, 'onRestart');
				log(i, 'onStart');
				resume(i);
				return;
			case 'dead':
				if (rules.deathRestarts) {
					if (!rules.noRestart) log(i, 'onRestart');
					log(i, 'onStart');
					resume(i);
				} else recreate(i);
		}
	};
	const requireForeground = (kind: string, want: boolean): void => {
		if (foreground !== want) throw new Error(`lifecycle: ${kind} with the task ${foreground ? 'in front' : 'behind'}`);
	};

	for (const event of scenario.events) {
		switch (event.kind) {
			case 'start': {
				requireForeground('start', true);
				const caller = stack[stack.length - 1];
				const spec = specOf(event.screen);
				const coversCaller = !spec.translucent || rules.translucentStops;
				const finishCaller = event.finishCaller && !rules.finishIgnored;
				let callerDone = false;
				if (caller) {
					pause(caller);
					if (rules.stopBeforeStart && coversCaller) {
						stop(caller, finishCaller);
						if (finishCaller) {
							log(caller, 'onDestroy');
							remove(caller);
						}
						callerDone = true;
					}
				}
				const inst: Instance = { spec, state: 'stopped' };
				stack.push(inst);
				log(inst, 'onCreate');
				if (event.finishInCreate) {
					if (rules.finishInCreateFull) {
						log(inst, 'onStart');
						log(inst, 'onResume');
						log(inst, 'onPause');
						stop(inst, true);
					}
					log(inst, 'onDestroy');
					remove(inst);
					if (caller) reveal(caller);
					break;
				}
				log(inst, 'onStart');
				resume(inst);
				if (caller && !callerDone) {
					if (finishCaller) {
						stop(caller, true);
						log(caller, 'onDestroy');
						remove(caller);
					} else if (coversCaller) stop(caller, false);
				}
				break;
			}
			case 'back': {
				requireForeground('back', true);
				const leaving = top();
				if (stack.length < 2) throw new Error('lifecycle: «Назад» on the last screen');
				pause(leaving);
				remove(leaving);
				if (rules.destroyBeforeReveal) {
					stop(leaving, true);
					log(leaving, 'onDestroy');
					reveal(top());
				} else {
					reveal(top());
					stop(leaving, true);
					log(leaving, 'onDestroy');
				}
				break;
			}
			case 'home':
			case 'lock': {
				requireForeground(event.kind, true);
				const t = top();
				if (t.spec.translucent) throw new Error('lifecycle: background with a translucent top');
				pause(t);
				stop(t, false);
				foreground = false;
				break;
			}
			case 'return':
			case 'unlock':
				requireForeground(event.kind, false);
				foreground = true;
				reveal(top());
				break;
			case 'dialog': {
				requireForeground('dialog', true);
				const t = top();
				if (rules.dialogPauses) {
					pause(t);
					resume(t);
				}
				break;
			}
			case 'overlay': {
				requireForeground('overlay', true);
				const t = top();
				pause(t);
				if (rules.translucentStops) stop(t, false);
				reveal(t);
				break;
			}
			case 'config': {
				requireForeground('config', true);
				const t = top();
				if (t.spec.translucent || stack.length > 1)
					throw new Error('lifecycle: a change of configuration over a stack');
				const declared = new Set(t.spec.configChanges);
				const handled = rules.declaredIgnored
					? false
					: rules.anyDeclared
						? event.changes.some((q) => declared.has(q))
						: event.changes.every((q) => declared.has(q));
				if (handled) {
					log(t, 'onConfigurationChanged');
					break;
				}
				pause(t);
				stop(t, false);
				log(t, 'onDestroy');
				recreate(t);
				break;
			}
			case 'kill':
				requireForeground('kill', false);
				for (let i = stack.length - 1; i >= 0; i -= 1) {
					const inst = stack[i] as Instance;
					if (rules.killCallsDestroy) log(inst, 'onDestroy');
					inst.state = 'dead';
				}
				break;
			case 'expire':
				expired = true;
				break;
		}
	}
	return out;
}

/** The stdin of `ACTIVITY_REFERENCE` for a scenario. */
export function activityReferenceInput(scenario: LifecycleScenario): string {
	return JSON.stringify(scenario);
}

/**
 * The independent reference: every event changes the stack or the foreground, and `settle` moves each screen to the
 * state its place demands — the top resumed in front, a screen under a translucent one paused, the rest stopped — in
 * three phases: pause who loses the focus, bring up who must be visible, stop and destroy who must not be.
 */
export const ACTIVITY_REFERENCE = `import json

d = json.loads(input())
spec = {s["name"]: s for s in d["screens"]}
out = []
world = {"front": True, "expired": False}
# entry: [name, state, finish_in_create]; state N (not created), D (dead process), S, P, R
stack = [[n, "R" if i == len(d["initial"]) - 1 else "S", False] for i, n in enumerate(d["initial"])]
LEVEL = {"N": 0, "D": 0, "S": 1, "P": 2, "R": 3}


def log(name, cb):
    if spec[name]["logged"]:
        out.append(name + "." + cb if d["prefix"] else cb)


def targets():
    t = ["S"] * len(stack)
    if world["front"]:
        for i in range(len(stack) - 1, -1, -1):
            t[i] = "R" if i == len(stack) - 1 else "P"
            if not spec[stack[i][0]]["translucent"]:
                break
    return t


def settle(finishing):
    t = targets()
    for e in finishing:
        if e[1] == "R":
            log(e[0], "onPause")
            e[1] = "P"
    for i in range(len(stack) - 1, -1, -1):
        if stack[i][1] == "R" and t[i] != "R":
            log(stack[i][0], "onPause")
            stack[i][1] = "P"
    i = len(stack) - 1
    while i >= 0:
        e = stack[i]
        want = t[i]
        if want != "S" and LEVEL[want] > LEVEL[e[1]]:
            name = e[0]
            if e[1] in ("N", "D"):
                log(name, "onCreate")
                if e[2]:
                    log(name, "onDestroy")
                    stack.pop(i)
                    settle(finishing)
                    return
                log(name, "onStart")
                if e[1] == "D":
                    log(name, "onRestoreInstanceState")
            elif e[1] == "S":
                log(name, "onRestart")
                log(name, "onStart")
            if want == "R":
                log(name, "onResume")
                e[1] = "R"
                if spec[name]["finishWhenExpired"] and world["expired"]:
                    stack.pop(i)
                    settle([e])
                    t = targets()
                    i = min(i, len(stack)) - 1
                    continue
            else:
                e[1] = "P"
        i -= 1
    t = targets()
    for i in range(len(stack) - 1, -1, -1):
        if t[i] == "S" and stack[i][1] in ("P", "R"):
            log(stack[i][0], "onStop")
            log(stack[i][0], "onSaveInstanceState")
            stack[i][1] = "S"
    for e in finishing:
        if e[1] == "P":
            log(e[0], "onStop")
        log(e[0], "onDestroy")
    finishing.clear()


for ev in d["events"]:
    k = ev["kind"]
    if k == "start":
        fin = []
        if ev["finishCaller"]:
            fin.append(stack.pop())
        stack.append([ev["screen"], "N", ev["finishInCreate"]])
        settle(fin)
    elif k == "back":
        settle([stack.pop()])
    elif k in ("home", "lock"):
        world["front"] = False
        settle([])
    elif k in ("return", "unlock"):
        world["front"] = True
        settle([])
    elif k == "overlay":
        log(stack[-1][0], "onPause")
        stack[-1][1] = "P"
        settle([])
    elif k == "config":
        e = stack[-1]
        if set(ev["changes"]) <= set(spec[e[0]]["configChanges"]):
            log(e[0], "onConfigurationChanged")
        else:
            for cb in ("onPause", "onStop", "onSaveInstanceState", "onDestroy"):
                log(e[0], cb)
            e[1] = "D"
            settle([])
    elif k == "kill":
        for e in stack:
            e[1] = "D"
    elif k == "expire":
        world["expired"] = True
for line in out:
    print(line)
`;

/** The qualifiers of `android:configChanges` as the manifest writes them. */
export const manifestValue = (qualifiers: readonly string[]): string => qualifiers.join('|');
