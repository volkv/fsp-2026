// A bash script of small helper functions, each with its specification in a comment; the last line runs the function
// named by the first argument. Exactly one line breaks its function's specification. The candidate names that line.
// The defect's kind is the essential class; the other functions, their order and the data are surface. The gate runs
// the script with the real bash of the sandbox image on the cases of every specification: with the defect some case
// fails, with the line restored every case passes.
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
import { bashBugProbe, type ShellFile } from '../../_lib/shell.ts';

const descriptor = readDescriptor(import.meta.url);

/** One run of the script: the function and its arguments, the files of the working directory, the expected output. */
interface Case {
	args: string[];
	files?: ShellFile[];
	expected: string;
}

/** A function of the script: its specification, its body and its possible defects. */
interface Fn {
	name: string;
	/** Arguments of an example call, shown in some instances. */
	example: string;
	spec: string;
	/** The body, the `name() {` and `}` lines excluded. */
	body: string[];
	cases: (rng: Rng) => Case[];
	defects: { kind: string; line: number; text: string; neighbour: number }[];
}

const out = (...lines: (string | number)[]): string => lines.map((l) => `${l}\n`).join('');
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'theta'] as const;
const lines = (rng: Rng, n: number): string[] =>
	Array.from({ length: n }, () => `${rng.pick(WORDS)} ${rng.int(1, 999)}`);
const text = (ls: readonly string[]): string => ls.map((l) => `${l}\n`).join('');

const INTERN: Fn[] = [
	{
		name: 'count_lines',
		example: '"daily report.txt"',
		spec: 'count_lines FILE — печатает число строк в файле FILE; имя файла может содержать пробелы.',
		body: ['\tlocal file=$1', '\twc -l < "$file"'],
		cases: (rng) => {
			const [a, b] = [rng.int(2, 9), rng.int(2, 9)];
			const spaced = `${rng.pick(['daily', 'weekly', 'old'])} report.txt`;
			return [
				{
					args: ['count_lines', 'plain.txt'],
					files: [{ path: 'plain.txt', content: text(lines(rng, a)) }],
					expected: out(a)
				},
				{ args: ['count_lines', spaced], files: [{ path: spaced, content: text(lines(rng, b)) }], expected: out(b) }
			];
		},
		defects: [{ kind: 'quoting', line: 1, text: '\twc -l < $file', neighbour: 0 }]
	},
	{
		name: 'show_title',
		example: '"Release  notes"',
		spec: 'show_title TEXT — печатает TEXT в квадратных скобках, сохраняя все пробелы внутри.',
		body: ['\tlocal title=$1', '\techo "[$title]"'],
		cases: (rng) => {
			const t = `${rng.pick(['Release', 'Deploy', 'Backup'])}  ${rng.pick(['notes', 'plan', 'report'])}`;
			return [{ args: ['show_title', t], expected: out(`[${t}]`) }];
		},
		defects: [{ kind: 'quoting', line: 1, text: '\techo [$title]', neighbour: 0 }]
	},
	{
		name: 'max_of',
		example: '3 12',
		spec: 'max_of A B — печатает большее из двух целых чисел.',
		body: ['\tif [ "$1" -gt "$2" ]; then', '\t\techo "$1"', '\telse', '\t\techo "$2"', '\tfi'],
		cases: (rng) => {
			const small = rng.int(2, 9);
			const big = rng.int(10, 99);
			return [
				{ args: ['max_of', String(small), String(big)], expected: out(big) },
				{ args: ['max_of', String(big + 100), String(small)], expected: out(big + 100) }
			];
		},
		defects: [{ kind: 'compare', line: 0, text: '\tif [[ "$1" > "$2" ]]; then', neighbour: 3 }]
	},
	{
		name: 'check_usage',
		example: '91 80',
		spec: 'check_usage PCT LIMIT — печатает ALERT, если PCT больше LIMIT, иначе OK.',
		body: [
			'\tlocal pct=$1 limit=$2',
			'\tif [ "$pct" -gt "$limit" ]; then',
			'\t\techo ALERT',
			'\telse',
			'\t\techo OK',
			'\tfi'
		],
		cases: (rng) => {
			const limit = rng.int(70, 90);
			return [
				{ args: ['check_usage', String(limit - rng.int(1, 9)), String(limit)], expected: out('OK') },
				{ args: ['check_usage', String(limit + rng.int(1, 9)), String(limit)], expected: out('ALERT') }
			];
		},
		defects: [{ kind: 'compare', line: 1, text: '\tif [ "$pct" > "$limit" ]; then', neighbour: 0 }]
	},
	{
		name: 'arg_summary',
		example: 'a b c',
		spec: 'arg_summary ARG... — печатает через пробел число аргументов и последний аргумент.',
		body: ['\tlocal count=$#', '\techo "$count ${!#}"'],
		cases: (rng) => {
			const args = rng.sample(WORDS, rng.int(3, 4));
			return [{ args: ['arg_summary', ...args], expected: out(`${args.length} ${args[args.length - 1]}`) }];
		},
		defects: [
			{ kind: 'args', line: 0, text: '\tlocal count=$1', neighbour: 1 },
			{ kind: 'args', line: 1, text: '\techo "$count $#"', neighbour: 0 }
		]
	},
	{
		name: 'each_arg',
		example: '"a b" c',
		spec: 'each_arg ARG... — печатает каждый аргумент на отдельной строке.',
		body: ['\tlocal a', '\tfor a in "$@"; do', '\t\techo "$a"', '\tdone'],
		cases: (rng) => {
			const args = [`${rng.pick(WORDS)} ${rng.pick(WORDS)}`, rng.pick(WORDS)];
			return [{ args: ['each_arg', ...args], expected: out(...args) }];
		},
		defects: [{ kind: 'args', line: 1, text: '\tfor a in "$*"; do', neighbour: 2 }]
	},
	{
		name: 'skip_header',
		example: 'data.csv',
		spec: 'skip_header FILE — печатает все строки файла, кроме первой (заголовка).',
		body: ['\tlocal file=$1', '\ttail -n +2 "$file"'],
		cases: (rng) => {
			const data = lines(rng, rng.int(2, 4));
			return [
				{
					args: ['skip_header', 'data.csv'],
					files: [{ path: 'data.csv', content: text(['name value', ...data]) }],
					expected: text(data)
				}
			];
		},
		defects: [{ kind: 'off-by-one', line: 1, text: '\ttail -n +1 "$file"', neighbour: 0 }]
	},
	{
		name: 'first_rows',
		example: 'data.csv 5',
		spec: 'first_rows FILE N — печатает первые N строк данных файла; первая строка файла — заголовок, она не печатается.',
		body: ['\tlocal file=$1 n=$2', '\ttail -n +2 "$file" | head -n "$n"'],
		cases: (rng) => {
			const data = lines(rng, 5);
			const n = rng.int(2, 3);
			return [
				{
					args: ['first_rows', 'rows.csv', String(n)],
					files: [{ path: 'rows.csv', content: text(['name value', ...data]) }],
					expected: text(data.slice(0, n))
				}
			];
		},
		defects: [{ kind: 'off-by-one', line: 1, text: '\thead -n "$n" "$file" | tail -n +2', neighbour: 0 }]
	},
	{
		name: 'countdown',
		example: '3',
		spec: 'countdown N — печатает числа от N до 1 по одному в строке.',
		body: ['\tlocal i', '\tfor ((i = $1; i > 0; i--)); do', '\t\techo "$i"', '\tdone'],
		cases: (rng) => {
			const n = rng.int(2, 4);
			return [{ args: ['countdown', String(n)], expected: out(...Array.from({ length: n }, (_, i) => n - i)) }];
		},
		defects: [{ kind: 'off-by-one', line: 1, text: '\tfor ((i = $1; i >= 0; i--)); do', neighbour: 2 }]
	}
];

const JUNIOR: Fn[] = [
	{
		name: 'print_raw',
		example: 'paths.txt',
		spec: 'print_raw FILE — печатает строки файла без изменений: обратные косые черты и начальные пробелы сохраняются.',
		body: ['\tlocal line', '\twhile IFS= read -r line; do', '\t\tprintf \'%s\\n\' "$line"', '\tdone < "$1"'],
		cases: (rng) => {
			const ls = [
				`C:\\${rng.pick(['temp', 'logs'])}\\${rng.pick(['new', 'tmp'])}`,
				`  ${rng.pick(WORDS)}`,
				rng.pick(WORDS)
			];
			return [
				{ args: ['print_raw', 'paths.txt'], files: [{ path: 'paths.txt', content: text(ls) }], expected: text(ls) }
			];
		},
		defects: [
			{ kind: 'read-raw', line: 1, text: '\twhile IFS= read line; do', neighbour: 2 },
			{ kind: 'read-raw', line: 1, text: '\twhile read -r line; do', neighbour: 3 }
		]
	},
	{
		name: 'key_values',
		example: 'app.env',
		spec: 'key_values FILE — для строк вида «ключ=значение» печатает «ключ: значение»; значение печатается как есть, вместе с обратными косыми чертами.',
		body: ['\tlocal key value', '\twhile IFS== read -r key value; do', '\t\techo "$key: $value"', '\tdone < "$1"'],
		cases: (rng) => {
			const kv = [
				['path', `D:\\${rng.pick(['data', 'cache'])}\\${rng.pick(['in', 'out'])}`],
				['mode', rng.pick(['fast', 'safe'])]
			];
			return [
				{
					args: ['key_values', 'app.env'],
					files: [{ path: 'app.env', content: text(kv.map(([k, v]) => `${k}=${v}`)) }],
					expected: text(kv.map(([k, v]) => `${k}: ${v}`))
				}
			];
		},
		defects: [{ kind: 'read-raw', line: 1, text: '\twhile IFS== read key value; do', neighbour: 0 }]
	},
	{
		name: 'deploy_mode',
		example: 'stage',
		spec: 'deploy_mode ENV — печатает dry-run, если ENV не равно prod (в том числе если ENV пустое), иначе deploy.',
		body: ['\tlocal env=$1', '\tif [ "$env" != prod ]; then', '\t\techo dry-run', '\telse', '\t\techo deploy', '\tfi'],
		cases: () => [
			{ args: ['deploy_mode', 'prod'], expected: out('deploy') },
			{ args: ['deploy_mode', 'stage'], expected: out('dry-run') },
			{ args: ['deploy_mode', ''], expected: out('dry-run') }
		],
		defects: [{ kind: 'empty-var', line: 1, text: '\tif [ $env != prod ]; then', neighbour: 0 }]
	},
	{
		name: 'flag_state',
		example: '"$VALUE"',
		spec: 'flag_state VALUE — печатает set, если VALUE непустое, иначе unset.',
		body: ['\tlocal value=$1', '\tif [ -n "$value" ]; then', '\t\techo set', '\telse', '\t\techo unset', '\tfi'],
		cases: (rng) => [
			{ args: ['flag_state', rng.pick(WORDS)], expected: out('set') },
			{ args: ['flag_state', ''], expected: out('unset') }
		],
		defects: [{ kind: 'empty-var', line: 1, text: '\tif [ -n $value ]; then', neighbour: 0 }]
	},
	{
		name: 'cleanup_tmp',
		example: '/tmp/build',
		spec: 'cleanup_tmp DIR — удаляет файлы *.tmp в каталоге DIR и печатает, что в нём осталось; если каталога нет — печатает «no dir» и ничего не удаляет.',
		body: ['\tcd "$1" || { echo "no dir"; return 1; }', '\trm -f ./*.tmp', '\tls'],
		cases: (rng) => {
			const keep = `${rng.pick(WORDS)}.txt`;
			const files = [
				{ path: 'work/a.tmp', content: 'x\n' },
				{ path: `work/${keep}`, content: 'x\n' },
				{ path: 'b.tmp', content: 'x\n' },
				{ path: 'main.txt', content: 'x\n' }
			];
			return [
				{ args: ['cleanup_tmp', 'work'], files, expected: out(keep) },
				{ args: ['cleanup_tmp', 'missing'], files, expected: out('no dir') }
			];
		},
		defects: [{ kind: 'rm-scope', line: 0, text: '\tcd "$1"', neighbour: 1 }]
	},
	{
		name: 'count_logs',
		example: '/var/log/app',
		spec: 'count_logs DIR — печатает число файлов *.log в самом каталоге DIR (без подкаталогов).',
		body: ['\tlocal dir=$1', '\tfind "$dir" -maxdepth 1 -name \'*.log\' | wc -l'],
		cases: (rng) => {
			const n = rng.int(1, 3);
			const files = [
				...Array.from({ length: n }, (_, i) => ({ path: `logs/s${i}.log`, content: 'x\n' })),
				{ path: 'logs/old/x.log', content: 'x\n' },
				...Array.from({ length: n + 2 }, (_, i) => ({ path: `top${i}.log`, content: 'x\n' }))
			];
			return [{ args: ['count_logs', 'logs'], files, expected: out(n) }];
		},
		defects: [{ kind: 'rm-scope', line: 1, text: "\tfind -maxdepth 1 -name '*.log' | wc -l", neighbour: 0 }]
	},
	{
		name: 'next_month',
		example: '09',
		spec: 'next_month MM — печатает номер следующего месяца двумя цифрами (12 -> 01); MM может начинаться с нуля.',
		body: ['\tlocal m=$((10#$1))', "\tprintf '%02d\\n' $((m % 12 + 1))"],
		cases: (rng) => {
			const m = rng.pick([8, 9]);
			return [
				{ args: ['next_month', `0${m}`], expected: out(String(m + 1).padStart(2, '0')) },
				{ args: ['next_month', '12'], expected: out('01') }
			];
		},
		defects: [{ kind: 'arith-octal', line: 0, text: '\tlocal m=$(($1))', neighbour: 1 }]
	},
	{
		name: 'to_minutes',
		example: '08:30',
		spec: 'to_minutes HH:MM — печатает число минут от полуночи; часы и минуты могут начинаться с нуля.',
		body: ['\tlocal h=${1%%:*} m=${1##*:}', '\techo $((10#$h * 60 + 10#$m))'],
		cases: (rng) => {
			const h = rng.pick([8, 9]);
			const m = rng.pick([8, 9, 30]);
			return [
				{ args: ['to_minutes', `0${h}:${String(m).padStart(2, '0')}`], expected: out(h * 60 + m) },
				{ args: ['to_minutes', '12:15'], expected: out(735) }
			];
		},
		defects: [{ kind: 'arith-octal', line: 1, text: '\techo $((h * 60 + m))', neighbour: 0 }]
	}
];

const TITLES = [
	'Служебные функции сервера сборки',
	'Помощники ротации журналов',
	'Утилиты деплоя',
	'Общие функции cron-задач'
];
const HEADER = [
	'readonly LOG_DIR=/var/log/app',
	'readonly KEEP=7',
	'export LC_ALL=C',
	'readonly RETRIES=3',
	'readonly TIMEOUT=30',
	'umask 022'
];

interface Program {
	source: string;
	cases: Case[];
	answer: number;
	fix: string;
	neighbour: number;
	other: number;
}

function compose(rng: Rng, library: readonly Fn[], kind: string, contextCount: number): Program {
	const candidates = library.flatMap((fn) =>
		fn.defects.filter((d) => d.kind === kind).map((defect) => ({ fn, defect }))
	);
	const { fn: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((fn) => fn !== buggy && !fn.defects.some((d) => d.kind === kind)),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A header of random length, so the defect's line number carries no hint.
	const header = rng.sample(HEADER, rng.int(0, 5));
	const lines: string[] = ['#!/bin/bash', `# ${rng.pick(TITLES)}.`];
	if (rng.bool()) lines.push('# Запуск: tool.sh ФУНКЦИЯ [АРГУМЕНТЫ...]');
	if (header.length) lines.push('', ...header);
	lines.push('');
	let answer = 0;
	let neighbour = 0;
	let other = 0;
	for (const fn of order) {
		lines.push(`# ${fn.spec}`);
		if (rng.bool(0.4)) lines.push(`# Пример: tool.sh ${fn.name} ${fn.example}`);
		lines.push(`${fn.name}() {`);
		const offset = lines.length;
		fn.body.forEach((line, i) => lines.push(fn === buggy && i === defect.line ? defect.text : line));
		if (fn === buggy) {
			answer = offset + defect.line + 1;
			neighbour = offset + defect.neighbour + 1;
		} else if (other === 0) other = offset + 1;
		lines.push('}', '');
	}
	lines.push('"$@"');
	const fix = buggy.body[defect.line] ?? '';
	const cases = order.flatMap((fn) => fn.cases(rng));
	return { source: lines.join('\n'), cases, answer, fix, neighbour, other };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p =
		input.grade === 'intern'
			? compose(rng, INTERN, input.classId, 3)
			: compose(rng, JUNIOR, input.classId, rng.int(3, 4));
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Скрипт `tool.sh` — набор функций; над каждой в комментарии записана её спецификация. Последняя строка вызывает функцию, ' +
				'имя которой передано первым аргументом, с остальными аргументами: `bash tool.sh ФУНКЦИЯ АРГУМЕНТЫ...`. Ровно одна строка ' +
				'скрипта нарушает спецификацию своей функции: если исправить только её, все функции будут работать по спецификации. ' +
				'Введите номер этой строки (нумерация с 1).',
			code: { language: 'shell', source: p.source }
		},
		answer: { kind: 'line_no', value: p.answer }
	});
	return {
		instance,
		reference: () =>
			bashBugProbe(
				p.source,
				p.answer,
				p.fix,
				p.cases.map((c) => ({ args: c.args, files: c.files ?? [], expected: c.expected }))
			),
		wrong: () => ({
			'neighbour-line': { kind: 'answer', answer: { kind: 'line_no', value: p.neighbour } },
			'other-function': { kind: 'answer', answer: { kind: 'line_no', value: p.other } }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
