// Recursive CTE: walking a hierarchy down and up, its closure and a generated calendar; walking a directed graph with
// cycles — UNION against UNION ALL, a depth limit, a path that guards against cycles.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows, runSql, sqlProbeSource, sqlText, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

interface Draft {
	setup: string;
	query: string;
	/** The rows a misconception gives, by its id; a misconception absent here does not apply to the class. */
	wrong: Record<string, string[]>;
}

interface Staff {
	setup: string;
	/** Manager of every employee by id (index 0 unused, 1 is the head). */
	manager: (number | null)[];
	depth: number[];
}

/** A company of n employees: the head is id 1, every other reports to someone with a smaller id. */
function staff(rng: Rng, n: number): Staff {
	const names = rng.sample(PERSON_NAMES, n);
	const manager: (number | null)[] = [null, null];
	const depth = [0, 0];
	for (let id = 2; id <= n; id += 1) {
		// Lean towards the latest employees so that the hierarchy is deep enough.
		const boss = rng.bool(0.6) ? rng.int(Math.max(1, id - 3), id - 1) : rng.int(1, id - 1);
		manager.push(boss);
		depth.push((depth[boss] ?? 0) + 1);
	}
	const rows = names.map((name, i) => [i + 1, name, manager[i + 1] ?? null, rng.int(5, 30) * 10]);
	const setup = `CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, manager_id INTEGER, salary INTEGER NOT NULL);\n${insertRows('employees', ['id', 'name', 'manager_id', 'salary'], rng.shuffle(rows))}`;
	return { setup, manager, depth };
}

function subordinatesDepth(rng: Rng): Draft {
	const s = staff(rng, rng.int(8, 10));
	// The root of the walk has grandchildren: someone two levels below reports to one of its reports.
	const candidates = s.manager
		.map((m, id) => ({ id, m }))
		.filter(({ m }) => m !== null)
		.map(({ m }) => s.manager[m ?? 0])
		.filter((g): g is number => typeof g === 'number');
	const root = candidates.length > 0 ? rng.pick(candidates) : 1;
	const cte = (anchor: string): string =>
		`WITH RECURSIVE sub(id, name, depth) AS (\n  SELECT id, name, 0 FROM employees WHERE id = ${root}\n  UNION ALL\n  SELECT e.id, e.name, s.depth + 1 FROM employees e JOIN sub s ON e.manager_id = s.id\n)\nSELECT name, depth FROM sub${anchor} ORDER BY depth, name;`;
	return {
		setup: s.setup,
		query: cte(''),
		wrong: {
			'one-level': runSql(
				s.setup,
				`SELECT name, 0 AS depth FROM employees WHERE id = ${root} UNION ALL SELECT name, 1 FROM employees WHERE manager_id = ${root} ORDER BY depth, name;`
			),
			'anchor-excluded': runSql(s.setup, cte(' WHERE depth > 0'))
		}
	};
}

function pathUp(rng: Rng): Draft {
	const s = staff(rng, rng.int(8, 10));
	const deepest = Math.max(...s.depth);
	const leaf = rng.pick(
		s.depth.map((d, id) => ({ d, id })).filter(({ d, id }) => id > 0 && d >= Math.min(3, deepest))
	).id;
	const cte = (concat: string, limit: string): string =>
		`WITH RECURSIVE up(id, manager_id, path, lvl) AS (\n  SELECT id, manager_id, name, 0 FROM employees WHERE id = ${leaf}\n  UNION ALL\n  SELECT e.id, e.manager_id, ${concat}, up.lvl + 1 FROM employees e JOIN up ON e.id = up.manager_id${limit}\n)\nSELECT lvl, path FROM up ORDER BY lvl;`;
	const right = "e.name || ' > ' || up.path";
	return {
		setup: s.setup,
		query: cte(right, ''),
		wrong: {
			'path-reversed': runSql(s.setup, cte("up.path || ' > ' || e.name", '')),
			'one-level': runSql(s.setup, cte(right, ' WHERE up.lvl < 1'))
		}
	};
}

function subtreeTotals(rng: Rng): Draft {
	const s = staff(rng, rng.int(7, 9));
	const report = (tree: string, payroll: string): string =>
		`${tree}\nSELECT r.name, COUNT(*) - 1 AS reports, ${payroll} AS payroll FROM tree t JOIN employees r ON r.id = t.root JOIN employees e ON e.id = t.id GROUP BY t.root HAVING COUNT(*) > 1 ORDER BY r.name;`;
	const tree =
		'WITH RECURSIVE tree(root, id) AS (\n  SELECT id, id FROM employees\n  UNION ALL\n  SELECT t.root, e.id FROM tree t JOIN employees e ON e.manager_id = t.id\n)';
	return {
		setup: s.setup,
		query: report(tree, 'SUM(e.salary)'),
		wrong: {
			'one-level': runSql(
				s.setup,
				report(
					'WITH tree(root, id) AS (SELECT id, id FROM employees UNION ALL SELECT manager_id, id FROM employees WHERE manager_id IS NOT NULL)',
					'SUM(e.salary)'
				)
			),
			'self-excluded': runSql(s.setup, report(tree, 'SUM(e.salary) - r.salary'))
		}
	};
}

function calendarFill(rng: Rng): Draft {
	const table = rng.pick(['sales', 'payments', 'visits']);
	const lo = rng.int(1, 20);
	const hi = lo + rng.int(4, 6);
	const rows: number[][] = [];
	const empty = rng.int(lo + 1, hi - 1);
	// The traps: the last day has sales, one day inside has none.
	rows.push([hi, rng.int(1, 30) * 10]);
	for (let d = lo; d <= hi; d += 1) {
		if (d === empty) continue;
		for (let k = rng.int(0, 2); k > 0; k -= 1) rows.push([d, rng.int(1, 30) * 10]);
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, day INTEGER NOT NULL, amount INTEGER NOT NULL);\n${insertRows(
		table,
		['id', 'day', 'amount'],
		rng.shuffle(rows).map((r, i) => [i + 1, ...r])
	)}`;
	const q = (stop: string, join: string): string =>
		`WITH RECURSIVE days(d) AS (\n  SELECT ${lo}\n  UNION ALL\n  SELECT d + 1 FROM days WHERE ${stop}\n)\nSELECT d, COUNT(s.id), COALESCE(SUM(s.amount), 0) FROM days ${join} ${table} s ON s.day = d GROUP BY d ORDER BY d;`;
	return {
		setup,
		query: q(`d < ${hi}`, 'LEFT JOIN'),
		wrong: {
			'stops-early': runSql(setup, q(`d < ${hi - 1}`, 'LEFT JOIN')),
			'left-as-inner': runSql(setup, q(`d < ${hi}`, 'JOIN'))
		}
	};
}

const NODES = ['mos', 'spb', 'kzn', 'nsk', 'ekb', 'omsk', 'perm', 'ufa', 'tula', 'tver', 'sochi', 'kursk'] as const;

interface Graph {
	setup: string;
	nodes: string[];
	edges: [string, string][];
}

/** A directed graph with a cycle of three and a few more edges, no self-loops or duplicates. */
function graph(rng: Rng, n: number, extra: number): Graph {
	const nodes = rng.sample(NODES, n);
	const [a, b, c] = nodes as [string, string, string];
	const edges: [string, string][] = [
		[a, b],
		[b, c],
		[c, a]
	];
	const has = (x: string, y: string): boolean => edges.some(([p, q]) => p === x && q === y);
	while (edges.length < 3 + extra) {
		const x = rng.pick(nodes);
		const y = rng.pick(nodes);
		if (x !== y && !has(x, y)) edges.push([x, y]);
	}
	const setup = `CREATE TABLE edges (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst));\n${insertRows('edges', ['src', 'dst'], rng.shuffle(edges))}`;
	return { setup, nodes, edges };
}

const UNDIRECTED = '(SELECT src, dst FROM edges UNION SELECT dst, src FROM edges)';

function reachUnion(rng: Rng): Draft {
	const g = graph(rng, rng.int(7, 8), rng.int(4, 6));
	const start = rng.pick(g.edges)[0];
	const q = (edges: string): string =>
		`WITH RECURSIVE reach(node) AS (\n  SELECT ${sqlText(start)}\n  UNION\n  SELECT e.dst FROM ${edges} e JOIN reach r ON e.src = r.node\n)\nSELECT node FROM reach ORDER BY node;`;
	return {
		setup: g.setup,
		query: q('edges'),
		wrong: {
			'edges-undirected': runSql(g.setup, q(UNDIRECTED)),
			'one-level': runSql(
				g.setup,
				`SELECT ${sqlText(start)} AS node UNION SELECT dst FROM edges WHERE src = ${sqlText(start)} ORDER BY node;`
			)
		}
	};
}

function boundedWalks(rng: Rng): Draft {
	const g = graph(rng, rng.int(5, 6), rng.int(3, 5));
	const start = rng.pick(g.edges)[0];
	const k = rng.int(3, 4);
	const q = (union: string, cond: string): string =>
		`WITH RECURSIVE walk(node, depth) AS (\n  SELECT ${sqlText(start)}, 0\n  ${union}\n  SELECT e.dst, w.depth + 1 FROM walk w JOIN edges e ON e.src = w.node WHERE ${cond}\n)\nSELECT node, COUNT(*), MIN(depth) FROM walk GROUP BY node ORDER BY node;`;
	return {
		setup: g.setup,
		query: q('UNION ALL', `w.depth < ${k}`),
		wrong: {
			'union-dedups-all': runSql(g.setup, q('UNION', `w.depth < ${k}`)),
			'limit-off-by-one': runSql(g.setup, q('UNION ALL', `w.depth <= ${k}`))
		}
	};
}

function simplePaths(rng: Rng): Draft {
	const g = graph(rng, rng.int(5, 6), rng.int(4, 6));
	const [from, to] = rng.sample(g.nodes, 2) as [string, string];
	const q = (edges: string, filter: string): string =>
		`WITH RECURSIVE p(node, path) AS (\n  SELECT ${sqlText(from)}, ${sqlText(from)}\n  UNION ALL\n  SELECT e.dst, p.path || '>' || e.dst FROM p JOIN ${edges} e ON e.src = p.node\n  WHERE instr('>' || p.path || '>', '>' || e.dst || '>') = 0\n)\nSELECT path FROM p WHERE node = ${sqlText(to)}${filter} ORDER BY path;`;
	const hops = "length(path) - length(replace(path, '>', ''))";
	return {
		setup: g.setup,
		query: q('edges', ''),
		wrong: {
			'shortest-only': runSql(
				g.setup,
				q('edges', ` AND ${hops} = (SELECT MIN(${hops}) FROM p WHERE node = ${sqlText(to)})`)
			),
			'edges-undirected': runSql(g.setup, q(UNDIRECTED, ''))
		}
	};
}

function closureSelf(rng: Rng): Draft {
	const g = graph(rng, rng.int(5, 6), rng.int(2, 4));
	const tail = 'GROUP BY s ORDER BY s;';
	const cte =
		'WITH RECURSIVE r(s, n) AS (\n  SELECT src, dst FROM edges\n  UNION\n  SELECT r.s, e.dst FROM r JOIN edges e ON e.src = r.n\n)';
	return {
		setup: g.setup,
		query: `${cte}\nSELECT s, COUNT(*) AS reachable, MAX(s = n) AS on_cycle FROM r ${tail}`,
		wrong: {
			'self-excluded': runSql(
				g.setup,
				`${cte}\nSELECT s, COUNT(*) AS reachable, MAX(s = n) AS on_cycle FROM r WHERE s <> n ${tail}`
			),
			'one-level': runSql(g.setup, 'SELECT src AS s, COUNT(*), MAX(src = dst) FROM edges GROUP BY src ORDER BY src;')
		}
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'middle/subordinates-depth': subordinatesDepth,
	'middle/path-up': pathUp,
	'middle/subtree-totals': subtreeTotals,
	'middle/calendar-fill': calendarFill,
	'senior/reach-union': reachUnion,
	'senior/bounded-walks': boundedWalks,
	'senior/simple-paths': simplePaths,
	'senior/closure-self': closureSelf
};

function sameRows(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	// Data are drawn until every misconception of the class changes the result.
	for (let tries = 0; tries < 200; tries += 1) {
		const q = draft(rng);
		const answer = runSql(q.setup, q.query);
		if (answer.length < 2) continue;
		if (Object.values(q.wrong).some((rows) => sameRows(rows, answer))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `Что вернёт запрос? База — SQLite, схема и данные приведены вместе с запросом.\n\n${SQL_ROW_FORMAT}`,
				code: { language: 'sql', source: `${q.setup}\n\n${q.query}` }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(q.setup, q.query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						const rows = q.wrong[id];
						return [
							id,
							rows === undefined
								? null
								: { kind: 'answer' as const, answer: { kind: 'sequence' as const, value: rows } }
						];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no data for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
