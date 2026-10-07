// A module of interface code with asynchronous calls, each function with its specification in a comment; exactly one
// line breaks its function's specification: a forgotten `return` in `then`, a forgotten `await`, `var` in a loop with
// timers, an error handler on the wrong promise; a level up, `forEach` with an async callback, `return` without `await`
// inside `try`, a nested promise that is not returned, a `catch` that swallows the error. The candidate names the line.
//
// The gate runs the module with Node: with the hidden checks it fails, with the defect line fixed it passes, and
// changing a distractor line instead does not repair it.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeDefectProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** A stub of the API at the top of the module: correct, shown to the candidate. */
interface Stub {
	name: string;
	lines: string[];
	needs: string[];
}

const STUBS: Stub[] = [
	{ name: 'delay', lines: ['const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));'], needs: [] },
	{
		name: 'fetchUser',
		lines: [
			'const users = {',
			"  1: { name: 'anna', friend: 2 },",
			"  2: { name: 'boris', friend: 3 },",
			"  3: { name: 'vera', friend: 1 },",
			'};',
			'',
			'async function fetchUser(id) {',
			'  await delay(1);',
			"  if (!users[id]) throw new Error('no user ' + id);",
			'  return { id, ...users[id] };',
			'}'
		],
		needs: ['delay']
	},
	{
		name: 'fetchName',
		lines: ['async function fetchName(id) {', '  const user = await fetchUser(id);', '  return user.name;', '}'],
		needs: ['fetchUser']
	},
	{
		name: 'store',
		lines: [
			'const storage = [];',
			'',
			'async function store(item) {',
			'  await delay(1);',
			'  storage.push(item);',
			'  return storage.length;',
			'}'
		],
		needs: ['delay']
	},
	{
		name: 'report',
		lines: [
			'const reported = [];',
			'',
			'function report(err) {',
			'  reported.push(err.message);',
			'  return null;',
			'}'
		],
		needs: []
	},
	{
		name: 'send',
		lines: [
			'async function send(form) {',
			'  await delay(1);',
			"  if (!form.ok) throw new Error('rejected');",
			'  return form.body;',
			'}'
		],
		needs: ['delay']
	},
	{
		name: 'render',
		lines: [
			'const cards = [];',
			'',
			'function render(user) {',
			"  if (user.name.length > 4) throw new Error('name too long');",
			'  cards.push(user.name);',
			'}'
		],
		needs: []
	},
	{
		name: 'upload',
		lines: [
			'const uploaded = [];',
			'',
			'async function upload(file) {',
			'  await delay(file.length);',
			'  uploaded.push(file);',
			'}'
		],
		needs: ['delay']
	},
	{
		name: 'remove',
		lines: [
			'const inbox = new Set([1, 2, 3, 4, 5]);',
			'',
			'async function remove(id) {',
			'  await delay(1);',
			'  inbox.delete(id);',
			'}'
		],
		needs: ['delay']
	},
	{
		name: 'persist',
		lines: [
			'async function persist(settings) {',
			'  await delay(1);',
			"  if (!settings.name) throw new Error('name required');",
			'  storage.push(settings.name);',
			'}'
		],
		needs: ['delay', 'store']
	},
	{
		name: 'publish',
		lines: ['async function publish(text) {', '  await delay(1);', '  return storage.indexOf(text) + 1;', '}'],
		needs: ['delay', 'store']
	},
	{
		name: 'fetchPage',
		lines: [
			'const spinner = { on: false };',
			'',
			'async function fetchPage(url) {',
			'  await delay(1);',
			"  if (!url.startsWith('/')) throw new Error('bad url ' + url);",
			"  return 'page ' + url;",
			'}'
		],
		needs: ['delay']
	}
];

/** A function of the module: its lines, the checks of its specification, its defects and harmless edits. */
interface Fn {
	name: string;
	needs: string[];
	lines: string[];
	/** Statements of an async check; they throw when the specification is broken. */
	check: string[];
	/** The defect: the line (0-based in `lines`), its broken text, and a neighbour line with a change that does not fix it. */
	defects: { kind: string; line: number; text: string; neighbour: { line: number; text: string } }[];
	/** A change of a correct line of the same kind a candidate may suspect when this function is not the broken one. */
	sibling: { line: number; text: string };
}

const INTERN: Fn[] = [
	{
		name: 'loadTitle',
		needs: ['fetchUser'],
		lines: [
			'// Промис с именем пользователя id в верхнем регистре.',
			'function loadTitle(id) {',
			'  return fetchUser(id).then((user) => {',
			'    const name = user.name;',
			'    return name.toUpperCase();',
			'  });',
			'}'
		],
		check: ["if ((await loadTitle(2)) !== 'BORIS') throw new Error('loadTitle');"],
		defects: [
			{
				kind: 'missing-return',
				line: 4,
				text: '    name.toUpperCase();',
				neighbour: { line: 3, text: '    let name = user.name;' }
			},
			{
				kind: 'missing-return',
				line: 2,
				text: '  fetchUser(id).then((user) => {',
				neighbour: { line: 4, text: '    return name.toUpperCase().trim();' }
			}
		],
		sibling: { line: 3, text: '    let name = user.name;' }
	},
	{
		name: 'countExisting',
		needs: ['fetchUser'],
		lines: [
			'// Промис с числом пользователей из списка ids, которые существуют.',
			'function countExisting(ids) {',
			'  const checks = ids.map((id) => fetchUser(id).then(() => 1, () => 0));',
			'  return Promise.all(checks).then((flags) => {',
			'    const total = flags.reduce((a, b) => a + b, 0);',
			'    return total;',
			'  });',
			'}'
		],
		check: ["if ((await countExisting([1, 7, 3])) !== 2) throw new Error('countExisting');"],
		defects: [
			{
				kind: 'missing-return',
				line: 5,
				text: '    total;',
				neighbour: { line: 4, text: '    const total = flags.reduce((a, b) => a + b);' }
			}
		],
		sibling: { line: 4, text: '    const total = flags.reduce((a, b) => a + b);' }
	},
	{
		name: 'greeting',
		needs: ['fetchUser'],
		lines: [
			"// Промис со строкой 'Hello, <имя>!' для пользователя id.",
			'async function greeting(id) {',
			'  const user = await fetchUser(id);',
			"  return 'Hello, ' + user.name + '!';",
			'}'
		],
		check: ["if ((await greeting(3)) !== 'Hello, vera!') throw new Error('greeting');"],
		defects: [
			{
				kind: 'missing-await',
				line: 2,
				text: '  const user = fetchUser(id);',
				neighbour: { line: 3, text: '  return `Hello, ${user.name}!`;' }
			}
		],
		sibling: { line: 3, text: '  return `Hello, ${user.name}!`;' }
	},
	{
		name: 'saveDrafts',
		needs: ['store'],
		lines: [
			'// Сохраняет черновики по очереди; промис выполняется, когда все сохранены, и даёт их число.',
			'async function saveDrafts(drafts) {',
			'  let saved = 0;',
			'  for (const draft of drafts) {',
			'    await store(draft);',
			'    saved += 1;',
			'  }',
			'  return saved;',
			'}'
		],
		check: [
			'storage.length = 0;',
			"const n = await saveDrafts(['a', 'b']);",
			"if (n !== 2 || storage.join() !== 'a,b') throw new Error('saveDrafts');"
		],
		defects: [
			{
				kind: 'missing-await',
				line: 4,
				text: '    store(draft);',
				neighbour: { line: 5, text: '    saved++;' }
			}
		],
		sibling: { line: 5, text: '    saved++;' }
	},
	{
		name: 'collectLater',
		needs: ['delay'],
		lines: [
			'// Через 1 мс кладёт в список числа 0, 1, …, n − 1 по порядку; промис даёт список, когда всё записано.',
			'function collectLater(n) {',
			'  const log = [];',
			'  for (let i = 0; i < n; i += 1) {',
			'    setTimeout(() => log.push(i), 1);',
			'  }',
			'  return delay(20).then(() => log);',
			'}'
		],
		check: ["if ((await collectLater(3)).join() !== '0,1,2') throw new Error('collectLater');"],
		defects: [
			{
				kind: 'var-timer',
				line: 3,
				text: '  for (var i = 0; i < n; i += 1) {',
				neighbour: { line: 4, text: '    setTimeout(() => log.push(i), 0);' }
			}
		],
		sibling: { line: 4, text: '    setTimeout(() => log.push(i), 0);' }
	},
	{
		name: 'makeLoaders',
		needs: ['delay'],
		lines: [
			'// Массив из n функций; i-я возвращает промис с числом i * 10.',
			'function makeLoaders(n) {',
			'  const loaders = [];',
			'  for (let i = 0; i < n; i += 1) {',
			'    loaders.push(() => delay(1).then(() => i * 10));',
			'  }',
			'  return loaders;',
			'}'
		],
		check: [
			'const loaders = makeLoaders(3);',
			'const got = await Promise.all(loaders.map((load) => load()));',
			"if (got.join() !== '0,10,20') throw new Error('makeLoaders');"
		],
		defects: [
			{
				kind: 'var-timer',
				line: 3,
				text: '  for (var i = 0; i < n; i += 1) {',
				neighbour: { line: 4, text: '    loaders.push(() => delay(0).then(() => i * 10));' }
			}
		],
		sibling: { line: 4, text: '    loaders.push(() => delay(0).then(() => i * 10));' }
	},
	{
		name: 'submitForm',
		needs: ['send', 'report'],
		lines: [
			'// Отправляет форму и разбирает ответ как JSON; ошибку отправки или разбора передаёт в report,',
			'// тогда промис даёт null.',
			'function submitForm(form) {',
			'  const sent = send(form);',
			'  const parsed = sent.then((text) => JSON.parse(text));',
			'  return parsed.catch((err) => report(err));',
			'}'
		],
		check: [
			'reported.length = 0;',
			'const good = await submitForm({ ok: true, body: \'{"id":7}\' });',
			"const broken = await submitForm({ ok: true, body: 'oops' });",
			"const failed = await submitForm({ ok: false, body: '' });",
			"if (good?.id !== 7 || broken !== null || failed !== null || reported.length !== 2) throw new Error('submitForm');"
		],
		defects: [
			{
				kind: 'wrong-chain',
				line: 5,
				text: '  return sent.catch((err) => report(err));',
				neighbour: { line: 4, text: '  const parsed = sent.then(JSON.parse);' }
			}
		],
		sibling: { line: 4, text: '  const parsed = sent.then(JSON.parse);' }
	},
	{
		name: 'refreshCard',
		needs: ['fetchUser', 'render', 'report'],
		lines: [
			'// Загружает пользователя id и рисует его карточку через render; если загрузка или render',
			'// падают — передаёт ошибку в report. Промис выполняется после этого в любом случае.',
			'function refreshCard(id) {',
			'  const loaded = fetchUser(id);',
			'  const drawn = loaded.then((user) => render(user));',
			'  return drawn.catch((err) => report(err));',
			'}'
		],
		check: [
			'reported.length = 0;',
			'cards.length = 0;',
			'await refreshCard(1);',
			'await refreshCard(2);',
			'await refreshCard(9);',
			"if (cards.join() !== 'anna' || reported.length !== 2) throw new Error('refreshCard');"
		],
		defects: [
			{
				kind: 'wrong-chain',
				line: 5,
				text: '  return loaded.catch((err) => report(err));',
				neighbour: { line: 4, text: '  const drawn = loaded.then(render);' }
			}
		],
		sibling: { line: 4, text: '  const drawn = loaded.then(render);' }
	}
];

const JUNIOR: Fn[] = [
	{
		name: 'uploadAll',
		needs: ['upload'],
		lines: [
			'// Загружает все файлы параллельно; промис выполняется, когда загружены все.',
			'async function uploadAll(files) {',
			'  await Promise.all(files.map((file) => upload(file)));',
			'}'
		],
		check: [
			'uploaded.length = 0;',
			"await uploadAll(['a.png', 'logo.svg']);",
			"if (uploaded.length !== 2) throw new Error('uploadAll');"
		],
		defects: [
			{
				kind: 'foreach-async',
				line: 2,
				text: '  files.forEach(async (file) => await upload(file));',
				neighbour: { line: 1, text: 'async function uploadAll(files = []) {' }
			}
		],
		sibling: { line: 2, text: '  await Promise.all(files.map(upload));' }
	},
	{
		name: 'purge',
		needs: ['remove'],
		lines: [
			'// Удаляет из ящика письма ids одно за другим; промис даёт число оставшихся писем.',
			'async function purge(ids) {',
			'  for (const id of ids) await remove(id);',
			'  return inbox.size;',
			'}'
		],
		check: ["if ((await purge([1, 4])) !== 3) throw new Error('purge');"],
		defects: [
			{
				kind: 'foreach-async',
				line: 2,
				text: '  ids.forEach(async (id) => await remove(id));',
				neighbour: { line: 3, text: '  return await inbox.size;' }
			}
		],
		sibling: { line: 3, text: '  return await inbox.size;' }
	},
	{
		name: 'safeName',
		needs: ['fetchName'],
		lines: [
			"// Промис с именем пользователя id; если такого нет — промис со строкой 'guest'.",
			'async function safeName(id) {',
			'  try {',
			'    return await fetchName(id);',
			'  } catch {',
			"    return 'guest';",
			'  }',
			'}'
		],
		check: [
			"if ((await safeName(1)) !== 'anna') throw new Error('safeName');",
			"if ((await safeName(8)) !== 'guest') throw new Error('safeName');"
		],
		defects: [
			{
				kind: 'try-no-await',
				line: 3,
				text: '    return fetchName(id);',
				neighbour: { line: 5, text: "    return await 'guest';" }
			}
		],
		sibling: { line: 5, text: "    return await 'guest';" }
	},
	{
		name: 'saveSettings',
		needs: ['persist', 'report'],
		lines: [
			'// Сохраняет настройки; промис даёт true, а при ошибке сохранения передаёт её в report и даёт false.',
			'async function saveSettings(settings) {',
			'  try {',
			'    await persist(settings);',
			'    return true;',
			'  } catch (err) {',
			'    report(err);',
			'    return false;',
			'  }',
			'}'
		],
		check: [
			'reported.length = 0;',
			"if ((await saveSettings({ name: 'dark' })) !== true) throw new Error('saveSettings');",
			"if ((await saveSettings({})) !== false || reported.length !== 1) throw new Error('saveSettings');"
		],
		defects: [
			{
				kind: 'try-no-await',
				line: 3,
				text: '    persist(settings);',
				neighbour: { line: 6, text: '    await report(err);' }
			}
		],
		sibling: { line: 6, text: '    await report(err);' }
	},
	{
		name: 'pairNames',
		needs: ['fetchUser'],
		lines: [
			'// Промис с массивом [имя пользователя id, имя его друга].',
			'function pairNames(id) {',
			'  return fetchUser(id).then((user) => {',
			'    return fetchUser(user.friend).then((friend) => [user.name, friend.name]);',
			'  });',
			'}'
		],
		check: ["if ((await pairNames(1)).join() !== 'anna,boris') throw new Error('pairNames');"],
		defects: [
			{
				kind: 'nested-no-return',
				line: 3,
				text: '    fetchUser(user.friend).then((friend) => [user.name, friend.name]);',
				neighbour: { line: 2, text: '  return fetchUser(id).then(async (user) => {' }
			}
		],
		sibling: { line: 2, text: '  return fetchUser(id).then(async (user) => {' }
	},
	{
		name: 'saveAndPublish',
		needs: ['store', 'publish'],
		lines: [
			'// Сохраняет текст, затем публикует его; промис выполняется после публикации и даёт её номер.',
			'function saveAndPublish(text) {',
			'  return store(text).then(() => {',
			'    return publish(text);',
			'  });',
			'}'
		],
		check: ['storage.length = 0;', "if ((await saveAndPublish('post')) !== 1) throw new Error('saveAndPublish');"],
		defects: [
			{
				kind: 'nested-no-return',
				line: 3,
				text: '    publish(text);',
				neighbour: { line: 2, text: '  return store(text).then(async () => {' }
			}
		],
		sibling: { line: 2, text: '  return store(text).then(async () => {' }
	},
	{
		name: 'loadOrReport',
		needs: ['fetchUser', 'report'],
		lines: [
			'// Промис с пользователем id; ошибку загрузки передаёт в report и отклоняет промис той же ошибкой.',
			'function loadOrReport(id) {',
			'  return fetchUser(id).catch((err) => {',
			'    report(err);',
			'    throw err;',
			'  });',
			'}'
		],
		check: [
			'reported.length = 0;',
			"if ((await loadOrReport(2)).name !== 'boris') throw new Error('loadOrReport');",
			'let rejected = false;',
			'await loadOrReport(6).catch(() => { rejected = true; });',
			"if (!rejected || reported.length !== 1) throw new Error('loadOrReport');"
		],
		defects: [
			{
				kind: 'catch-swallows',
				line: 4,
				text: '    return err;',
				neighbour: { line: 3, text: '    report(err) ?? null;' }
			}
		],
		sibling: { line: 3, text: '    report(err) ?? null;' }
	},
	{
		name: 'loadPage',
		needs: ['fetchPage'],
		lines: [
			'// Промис с текстом страницы; ошибку загрузки не скрывает (промис отклоняется),',
			'// а индикатор загрузки выключает в любом случае.',
			'function loadPage(url) {',
			'  spinner.on = true;',
			'  return fetchPage(url).finally(() => {',
			'    spinner.on = false;',
			'  });',
			'}'
		],
		check: [
			"if ((await loadPage('/home')) !== 'page /home' || spinner.on) throw new Error('loadPage');",
			'let rejected = false;',
			"await loadPage('home').catch(() => { rejected = true; });",
			"if (!rejected || spinner.on) throw new Error('loadPage');"
		],
		defects: [
			{
				kind: 'catch-swallows',
				line: 4,
				text: '  return fetchPage(url).catch(() => {',
				neighbour: { line: 3, text: '  spinner.on = !spinner.on;' }
			}
		],
		sibling: { line: 3, text: '  spinner.on = !spinner.on;' }
	}
];

const HEADER_CONSTANTS = [
	'const PAGE_SIZE = 20;',
	"const API_BASE = '/api/v2';",
	'const RETRY_LIMIT = 3;',
	"const LOCALE = 'ru';",
	'const DEBUG = false;',
	'const TIMEOUT_MS = 5000;',
	"const THEME = 'light';"
];
const MODULE_TITLES = [
	'Модуль профиля пользователя',
	'Утилиты формы настроек',
	'Код ленты и карточек',
	'Обработчики экрана загрузки'
];

interface Program {
	source: string;
	check: string;
	line: number;
	fix: string;
	neighbour: { line: number; text: string };
	/** A line of a correct function a candidate may suspect, with the change they would make there. */
	other: { line: number; text: string };
}

/** The stubs the functions need, with their own needs, in the order of `STUBS`. */
function stubsFor(fns: readonly Fn[]): Stub[] {
	const wanted = new Set<string>();
	const add = (name: string): void => {
		if (wanted.has(name)) return;
		wanted.add(name);
		for (const need of STUBS.find((s) => s.name === name)?.needs ?? []) add(need);
	};
	for (const fn of fns) for (const need of fn.needs) add(need);
	return STUBS.filter((s) => wanted.has(s.name));
}

function compose(rng: Rng, library: readonly Fn[], kind: string, contextCount: number): Program {
	const candidates = library.flatMap((fn) =>
		fn.defects.filter((d) => d.kind === kind).map((defect) => ({ fn, defect }))
	);
	const { fn: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((fn) => fn !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 5));
	// Blocks of the module, separated by one blank line: a header of random length, the stubs, the functions.
	const blocks: string[][] = [[`// ${rng.pick(MODULE_TITLES)}. Заглушки API в начале модуля исправны.`]];
	if (constants.length) blocks.push(constants);
	for (const stub of stubsFor(order)) blocks.push(stub.lines);
	const lines: string[] = [];
	const offsets = new Map<Fn, number>();
	for (const block of blocks) lines.push(...block, '');
	for (const fn of order) {
		offsets.set(fn, lines.length);
		lines.push(...fn.lines.map((line, i) => (fn === buggy && i === defect.line ? defect.text : line)), '');
	}
	lines.pop();
	const at = (fn: Fn, index: number): number => (offsets.get(fn) ?? 0) + index + 1;
	const sibling = context[0];
	if (!sibling) throw new Error(`${descriptor.key}: a module needs a correct function besides the broken one`);
	const check = [
		'',
		'const __checks = [',
		...order.map((fn) => `  async () => {\n${fn.check.map((c) => `    ${c}`).join('\n')}\n  },`),
		'];',
		'(async () => {',
		'  for (const run of __checks) await run();',
		"  console.log('ok');",
		"})().catch((err) => console.log('fail', err.message));"
	].join('\n');
	return {
		source: lines.join('\n'),
		check,
		line: at(buggy, defect.line),
		fix: buggy.lines[defect.line] ?? '',
		neighbour: { line: at(buggy, defect.neighbour.line), text: defect.neighbour.text },
		other: { line: at(sibling, sibling.sibling.line), text: sibling.sibling.text }
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const intern = input.grade === 'intern';
	const p = compose(rng, intern ? INTERN : JUNIOR, input.classId, intern ? 2 : rng.int(2, 3));
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль интерфейса на JavaScript (Node.js 24). Над каждой функцией в комментарии записано, что она должна делать; ' +
				'заглушки API в начале модуля исправны. Ровно одна строка модуля нарушает спецификацию своей функции: если заменить ' +
				'только её, все функции будут работать по спецификации. Введите номер этой строки (нумерация с 1).',
			code: { language: 'javascript', source: p.source }
		},
		answer: { kind: 'line_no', value: p.line }
	});
	return {
		instance,
		reference: () =>
			nodeDefectProbe({
				source: p.source,
				language: 'javascript',
				check: p.check,
				line: p.line,
				fix: p.fix,
				distractors: [p.neighbour, p.other].map((d) => ({ line: d.line, replacement: d.text }))
			}),
		wrong: () => ({
			'neighbour-line': { kind: 'answer', answer: { kind: 'line_no', value: p.neighbour.line } },
			'other-function': { kind: 'answer', answer: { kind: 'line_no', value: p.other.line } }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
