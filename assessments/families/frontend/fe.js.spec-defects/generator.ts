// A module of frontend utilities in JavaScript, each function with its specification in JSDoc; exactly one line breaks
// its function's specification. The candidate names that line. The kind of the defect is the essential class, and the
// function carrying it is one of the class's fixed manifestations; the other functions, their order and the module
// header are surface. On the junior level functions come in groups that call each other, and the defect shows up in a
// caller. The gate runs the module with the checks of every function appended: it fails, passes with the defect line
// fixed, and still fails when a trap line is changed instead.
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

/** A change of one line: the exact original text and what replaces it. */
interface Change {
	from: string;
	to: string;
}

interface Defect extends Change {
	kind: string;
	/** Another line of the same function and the change a candidate would make there. */
	neighbour: Change;
	/** Junior: a line of another function of the group where the defect shows up. */
	symptom?: Change;
	/** Other lines whose one-instruction change also restores the specification: accepted answers. */
	alternatives?: Change[];
}

/** A function, or on the junior level a group of functions calling each other, with the checks of its specification. */
interface Unit {
	lines: string[];
	/** JavaScript statements that throw when the specification is broken; `__eq` compares JSON forms. */
	checks: string[];
	defects: Defect[];
	/** A correct line that looks suspicious, with a plausible change: the trap when the unit is shown without a defect. */
	decoy: Change;
}

const INTERN: Unit[] = [
	{
		lines: [
			'/**',
			' * Цена в рублях: целая часть с пробелом между тысячами и знак ₽, копейки отбрасываются.',
			' * value — конечное число от 0 до 10^15.',
			" * formatPrice(1234567.8) → '1 234 567 ₽', formatPrice(950) → '950 ₽'.",
			' */',
			'function formatPrice(value) {',
			'  const digits = String(Math.floor(value));',
			'  const groups = [];',
			'  for (let end = digits.length; end > 0; end -= 3) {',
			'    groups.unshift(digits.slice(Math.max(0, end - 3), end));',
			'  }',
			"  return groups.join(' ') + ' ₽';",
			'}'
		],
		checks: [
			"__eq(formatPrice(1234567.8), '1 234 567 ₽');",
			"__eq(formatPrice(950), '950 ₽');",
			"__eq(formatPrice(1000), '1 000 ₽');"
		],
		defects: [
			{
				kind: 'boundary',
				from: '  for (let end = digits.length; end > 0; end -= 3) {',
				to: '  for (let end = digits.length; end > 1; end -= 3) {',
				neighbour: {
					from: '    groups.unshift(digits.slice(Math.max(0, end - 3), end));',
					to: '    groups.unshift(digits.slice(Math.max(1, end - 3), end));'
				}
			}
		],
		decoy: { from: '  const digits = String(Math.floor(value));', to: '  const digits = String(Math.round(value));' }
	},
	{
		lines: [
			'/**',
			' * Обрезает текст до max символов вместе с многоточием «…»; текст не длиннее max не меняется.',
			' * max — целое число от 1; длина текста — text.length.',
			" * truncate('Привет, мир', 7) → 'Привет…'.",
			' */',
			'function truncate(text, max) {',
			'  if (text.length <= max) return text;',
			"  return text.slice(0, max - 1) + '…';",
			'}'
		],
		checks: [
			"__eq(truncate('Привет, мир', 7), 'Привет…');",
			"__eq(truncate('abc', 3), 'abc');",
			"__eq(truncate('abcd', 3), 'ab…');"
		],
		defects: [
			{
				kind: 'boundary',
				from: '  if (text.length <= max) return text;',
				to: '  if (text.length < max) return text;',
				neighbour: { from: "  return text.slice(0, max - 1) + '…';", to: "  return text.slice(0, max) + '…';" }
			},
			{
				kind: 'boundary',
				from: "  return text.slice(0, max - 1) + '…';",
				to: "  return text.slice(0, max) + '…';",
				neighbour: { from: '  if (text.length <= max) return text;', to: '  if (text.length < max) return text;' }
			}
		],
		decoy: { from: "  return text.slice(0, max - 1) + '…';", to: "  return text.substring(0, max) + '…';" }
	},
	{
		lines: [
			'/**',
			' * Элементы страницы page (нумерация с 1) по size штук; page и size — целые числа от 1.',
			' * pageItems([1, 2, 3, 4, 5], 2, 2) → [3, 4].',
			' */',
			'function pageItems(items, page, size) {',
			'  const start = (page - 1) * size;',
			'  return items.slice(start, start + size);',
			'}'
		],
		checks: [
			'__eq(pageItems([1, 2, 3, 4, 5], 2, 2), [3, 4]);',
			'__eq(pageItems([1, 2, 3, 4, 5], 3, 2), [5]);',
			'__eq(pageItems([1, 2, 3], 1, 5), [1, 2, 3]);'
		],
		defects: [
			{
				kind: 'boundary',
				from: '  const start = (page - 1) * size;',
				to: '  const start = page * size;',
				neighbour: {
					from: 'function pageItems(items, page, size) {',
					to: 'function pageItems(items, page, size = 10) {'
				},
				alternatives: [
					{ from: '  return items.slice(start, start + size);', to: '  return items.slice(start - size, start);' }
				]
			},
			{
				kind: 'boundary',
				from: '  return items.slice(start, start + size);',
				to: '  return items.slice(start, start + size - 1);',
				neighbour: { from: '  const start = (page - 1) * size;', to: '  const start = page * size - 1;' }
			}
		],
		decoy: { from: '  return items.slice(start, start + size);', to: '  return items.slice(start, size);' }
	},
	{
		lines: [
			'/**',
			' * Сколько страниц по size элементов нужно для total элементов; при total = 0 — 0.',
			' * total — целое число от 0, size — целое число от 1.',
			' */',
			'function pageCount(total, size) {',
			'  return Math.ceil(total / size);',
			'}'
		],
		checks: ['__eq(pageCount(10, 5), 2);', '__eq(pageCount(11, 5), 3);', '__eq(pageCount(0, 5), 0);'],
		defects: [
			{
				kind: 'boundary',
				from: '  return Math.ceil(total / size);',
				to: '  return Math.floor(total / size) + 1;',
				neighbour: { from: 'function pageCount(total, size) {', to: 'function pageCount(total, size = 10) {' }
			}
		],
		decoy: { from: '  return Math.ceil(total / size);', to: '  return Math.round(total / size);' }
	},
	{
		lines: [
			'/**',
			' * Один ли это id: из адресной строки id приходит строкой, из API — числом.',
			" * Сравниваются как строки: 7 и '7' — один id, '07' и 7 — разные.",
			' */',
			'function isSameId(a, b) {',
			'  return String(a) === String(b);',
			'}'
		],
		checks: [
			"__eq(isSameId(7, '7'), true);",
			"__eq(isSameId('7', 7), true);",
			"__eq(isSameId('07', 7), false);",
			'__eq(isSameId(7, 8), false);'
		],
		defects: [
			{
				kind: 'coercion',
				from: '  return String(a) === String(b);',
				to: '  return a === b;',
				neighbour: { from: 'function isSameId(a, b) {', to: "function isSameId(a, b = '') {" }
			},
			{
				kind: 'coercion',
				from: '  return String(a) === String(b);',
				to: '  return a == b;',
				neighbour: { from: 'function isSameId(a, b) {', to: "function isSameId(a, b = '') {" }
			}
		],
		decoy: { from: '  return String(a) === String(b);', to: '  return String(a) == String(b);' }
	},
	{
		lines: [
			'/**',
			" * Общее количество товаров; quantity приходит из поля ввода строкой с целым числом от 0: '2'.",
			' */',
			'function sumQuantities(lines) {',
			'  let total = 0;',
			'  for (const line of lines) {',
			'    total += Number(line.quantity);',
			'  }',
			'  return total;',
			'}'
		],
		checks: ["__eq(sumQuantities([{ quantity: '2' }, { quantity: '3' }]), 5);", '__eq(sumQuantities([]), 0);'],
		defects: [
			{
				kind: 'coercion',
				from: '    total += Number(line.quantity);',
				to: '    total += line.quantity;',
				neighbour: { from: '  let total = 0;', to: '  let total = Number(0);' }
			}
		],
		decoy: { from: '  for (const line of lines) {', to: '  for (const line of Object.values(lines)) {' }
	},
	{
		lines: [
			'/**',
			' * Номер страницы из строки запроса: целое число от 1. Число читается по ведущим цифрам, как parseInt;',
			' * пустая строка, строка без ведущих цифр и число меньше 1 — 1.',
			" * parsePage('3') → 3, parsePage('3abc') → 3, parsePage('') → 1, parsePage('abc') → 1.",
			' */',
			'function parsePage(raw) {',
			'  const page = Number.parseInt(raw, 10);',
			'  return Number.isNaN(page) || page < 1 ? 1 : page;',
			'}'
		],
		checks: [
			"__eq(parsePage('3'), 3);",
			"__eq(parsePage('3abc'), 3);",
			"__eq(parsePage(''), 1);",
			"__eq(parsePage('abc'), 1);",
			"__eq(parsePage('-2'), 1);"
		],
		defects: [
			{
				kind: 'coercion',
				from: '  return Number.isNaN(page) || page < 1 ? 1 : page;',
				to: '  return page == NaN || page < 1 ? 1 : page;',
				neighbour: { from: 'function parsePage(raw) {', to: "function parsePage(raw = '') {" },
				alternatives: [
					{ from: '  const page = Number.parseInt(raw, 10);', to: '  const page = Number.parseInt(raw, 10) || 1;' }
				]
			}
		],
		decoy: { from: '  const page = Number.parseInt(raw, 10);', to: '  const page = Number.parseInt(raw);' }
	},
	{
		lines: [
			'/**',
			' * Параметры списка. pageSize: не задан — 20, 0 означает «без пагинации» и сохраняется.',
			" * sort: не задан — 'date', пустая строка означает «без сортировки» и сохраняется.",
			' */',
			'function withDefaults(options) {',
			'  return {',
			'    pageSize: options.pageSize ?? 20,',
			"    sort: options.sort ?? 'date'",
			'  };',
			'}'
		],
		checks: [
			"__eq(withDefaults({}), { pageSize: 20, sort: 'date' });",
			"__eq(withDefaults({ pageSize: 0, sort: '' }), { pageSize: 0, sort: '' });",
			"__eq(withDefaults({ pageSize: 50, sort: 'price' }), { pageSize: 50, sort: 'price' });"
		],
		defects: [
			{
				kind: 'falsy',
				from: '    pageSize: options.pageSize ?? 20,',
				to: '    pageSize: options.pageSize || 20,',
				neighbour: { from: "    sort: options.sort ?? 'date'", to: "    sort: options.sort || 'date'" }
			},
			{
				kind: 'falsy',
				from: "    sort: options.sort ?? 'date'",
				to: "    sort: options.sort || 'date'",
				neighbour: { from: '    pageSize: options.pageSize ?? 20,', to: '    pageSize: options.pageSize || 20,' }
			}
		],
		decoy: { from: '    pageSize: options.pageSize ?? 20,', to: '    pageSize: Number(options.pageSize ?? 20),' }
	},
	{
		lines: [
			'/**',
			" * Подпись скидки: null — 'без скидки', иначе процент: 0 → '0%', 15 → '15%'.",
			' * percent — null или целое число от 0 до 100.',
			' */',
			'function discountLabel(percent) {',
			"  if (percent === null) return 'без скидки';",
			"  return percent + '%';",
			'}'
		],
		checks: [
			"__eq(discountLabel(null), 'без скидки');",
			"__eq(discountLabel(0), '0%');",
			"__eq(discountLabel(15), '15%');"
		],
		defects: [
			{
				kind: 'falsy',
				from: "  if (percent === null) return 'без скидки';",
				to: "  if (!percent) return 'без скидки';",
				neighbour: { from: "  return percent + '%';", to: "  return String(percent) + '%';" }
			}
		],
		decoy: { from: "  if (percent === null) return 'без скидки';", to: "  if (percent == null) return 'без скидки';" }
	},
	{
		lines: [
			'/**',
			" * Первый элемент списка или fallback, если список пуст. Элементом может быть 0 или ''.",
			' */',
			'function firstOr(list, fallback) {',
			'  return list.length > 0 ? list[0] : fallback;',
			'}'
		],
		checks: ['__eq(firstOr([0, 5], 9), 0);', '__eq(firstOr([], 9), 9);', "__eq(firstOr(['', 'a'], 'x'), '');"],
		defects: [
			{
				kind: 'falsy',
				from: '  return list.length > 0 ? list[0] : fallback;',
				to: '  return list[0] || fallback;',
				neighbour: { from: 'function firstOr(list, fallback) {', to: 'function firstOr(list, fallback = null) {' }
			}
		],
		decoy: { from: '  return list.length > 0 ? list[0] : fallback;', to: '  return list.length ? list[0] : fallback;' }
	},
	{
		lines: [
			'/**',
			' * Новый массив товаров по возрастанию цены; исходный массив не меняется.',
			' */',
			'function sortedByPrice(products) {',
			'  const copy = [...products];',
			'  copy.sort((a, b) => a.price - b.price);',
			'  return copy;',
			'}'
		],
		checks: [
			'const products = [{ price: 3 }, { price: 1 }, { price: 2 }];',
			'__eq(sortedByPrice(products).map((p) => p.price), [1, 2, 3]);',
			'__eq(products.map((p) => p.price), [3, 1, 2]);'
		],
		defects: [
			{
				kind: 'mutation',
				from: '  const copy = [...products];',
				to: '  const copy = products;',
				neighbour: { from: '  return copy;', to: '  return [...copy];' },
				alternatives: [{ from: 'function sortedByPrice(products) {', to: 'function sortedByPrice([...products]) {' }]
			}
		],
		decoy: { from: '  copy.sort((a, b) => a.price - b.price);', to: '  copy.sort((a, b) => b.price - a.price);' }
	},
	{
		lines: [
			'/**',
			' * Новый список тегов; tags — список без повторов. Если tag в нём нет — tag добавляется в конец,',
			' * если есть — возвращается копия tags без изменений. Исходный список не меняется.',
			' */',
			'function addTag(tags, tag) {',
			'  if (tags.includes(tag)) return [...tags];',
			'  const next = tags.slice();',
			'  next.push(tag);',
			'  return next;',
			'}'
		],
		checks: [
			"const tags = ['a'];",
			"__eq(addTag(tags, 'b'), ['a', 'b']);",
			"__eq(tags, ['a']);",
			"__eq(addTag(tags, 'a'), ['a']);",
			"__eq(addTag(['a', 'b'], 'a'), ['a', 'b']);"
		],
		defects: [
			{
				kind: 'mutation',
				from: '  const next = tags.slice();',
				to: '  const next = tags;',
				neighbour: {
					from: '  if (tags.includes(tag)) return [...tags];',
					to: '  if (tags.includes(tag)) return tags;'
				},
				alternatives: [{ from: 'function addTag(tags, tag) {', to: 'function addTag([...tags], tag) {' }]
			}
		],
		decoy: { from: '  next.push(tag);', to: '  next.unshift(tag);' }
	},
	{
		lines: [
			'/**',
			' * Настройки пользователя поверх настроек по умолчанию; объект defaults не меняется.',
			' */',
			'function mergeSettings(defaults, user) {',
			'  const merged = Object.assign({}, defaults, user);',
			'  return merged;',
			'}'
		],
		checks: [
			"const defaults = { theme: 'light', lang: 'ru' };",
			"__eq(mergeSettings(defaults, { theme: 'dark' }), { theme: 'dark', lang: 'ru' });",
			"__eq(defaults, { theme: 'light', lang: 'ru' });"
		],
		defects: [
			{
				kind: 'mutation',
				from: '  const merged = Object.assign({}, defaults, user);',
				to: '  const merged = Object.assign(defaults, user);',
				neighbour: { from: '  return merged;', to: '  return { ...merged };' },
				alternatives: [
					{ from: 'function mergeSettings(defaults, user) {', to: 'function mergeSettings({ ...defaults }, user) {' }
				]
			}
		],
		decoy: {
			from: '  const merged = Object.assign({}, defaults, user);',
			to: '  const merged = Object.assign({}, user, defaults);'
		}
	}
];

const JUNIOR: Unit[] = [
	{
		lines: [
			'/**',
			' * Число страниц по size элементов; для пустого списка — 1 (пустая первая страница).',
			' * count — целое число от 0, size — целое число от 1.',
			' */',
			'function totalPages(count, size) {',
			'  return Math.max(1, Math.ceil(count / size));',
			'}',
			'',
			'/**',
			' * Номер страницы, приведённый к диапазону от 1 до totalPages(count, size) включительно.',
			' */',
			'function clampPage(page, count, size) {',
			'  const last = totalPages(count, size);',
			'  return Math.min(Math.max(page, 1), last);',
			'}',
			'',
			'/**',
			' * Страница списка: её элементы, номер после приведения и есть ли следующая страница; page — любое целое.',
			' * paginate([1, 2, 3, 4, 5], 9, 2) → { items: [5], page: 3, hasNext: false }.',
			' */',
			'function paginate(items, page, size) {',
			'  const current = clampPage(page, items.length, size);',
			'  const start = (current - 1) * size;',
			'  return {',
			'    items: items.slice(start, start + size),',
			'    page: current,',
			'    hasNext: current < totalPages(items.length, size)',
			'  };',
			'}'
		],
		checks: [
			'__eq(totalPages(4, 2), 2);',
			'__eq(totalPages(5, 2), 3);',
			'__eq(totalPages(0, 3), 1);',
			'__eq(clampPage(9, 5, 2), 3);',
			'__eq(clampPage(0, 5, 2), 1);',
			'__eq(paginate([1, 2, 3, 4, 5], 9, 2), { items: [5], page: 3, hasNext: false });',
			'__eq(paginate([1, 2, 3, 4, 5], 1, 2), { items: [1, 2], page: 1, hasNext: true });',
			'__eq(paginate([], 4, 3), { items: [], page: 1, hasNext: false });'
		],
		defects: [
			{
				kind: 'boundary',
				from: '  return Math.max(1, Math.ceil(count / size));',
				to: '  return Math.max(1, Math.floor(count / size));',
				neighbour: { from: 'function totalPages(count, size) {', to: 'function totalPages(count, size = 1) {' },
				symptom: {
					from: '  const last = totalPages(count, size);',
					to: '  const last = Math.max(totalPages(count, size), 1);'
				}
			},
			{
				kind: 'boundary',
				from: '  return Math.min(Math.max(page, 1), last);',
				to: '  return Math.min(Math.max(page, 1), last - 1);',
				neighbour: {
					from: 'function clampPage(page, count, size) {',
					to: 'function clampPage(page, count, size = 1) {'
				},
				alternatives: [
					{ from: '  const last = totalPages(count, size);', to: '  const last = totalPages(count, size) + 1;' }
				],
				symptom: {
					from: '  const current = clampPage(page, items.length, size);',
					to: '  const current = clampPage(page, items.length, size) || 1;'
				}
			},
			{
				kind: 'boundary',
				from: '    hasNext: current < totalPages(items.length, size)',
				to: '    hasNext: current <= totalPages(items.length, size)',
				neighbour: { from: '  const start = (current - 1) * size;', to: '  const start = current * size - size;' },
				symptom: {
					from: '  return Math.min(Math.max(page, 1), last);',
					to: '  return Math.max(Math.min(page, last), 1);'
				}
			}
		],
		decoy: {
			from: '    items: items.slice(start, start + size),',
			to: '    items: items.slice(start, start + size + 1),'
		}
	},
	{
		lines: [
			'/**',
			' * Видимые строки виртуального списка: строки высотой rowHeight, окно высотой height прокручено на scrollTop.',
			' * Видна строка, хотя бы частично попавшая в окно; индексы — в пределах [0, count).',
			' * count — целое число от 1; height и rowHeight — положительные; 0 <= scrollTop < count * rowHeight.',
			' */',
			'function visibleRange(scrollTop, height, rowHeight, count) {',
			'  const first = Math.floor(scrollTop / rowHeight);',
			'  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / rowHeight) - 1);',
			'  return { first, last };',
			'}',
			'',
			'/**',
			' * Элементы, которые нужно отрисовать при текущей прокрутке.',
			' */',
			'function renderSlice(items, scrollTop, height, rowHeight) {',
			'  const { first, last } = visibleRange(scrollTop, height, rowHeight, items.length);',
			'  return items.slice(first, last + 1);',
			'}'
		],
		checks: [
			'__eq(visibleRange(0, 100, 20, 50), { first: 0, last: 4 });',
			'__eq(visibleRange(30, 100, 20, 50), { first: 1, last: 6 });',
			'__eq(visibleRange(900, 200, 20, 50), { first: 45, last: 49 });',
			"__eq(renderSlice(['a', 'b', 'c', 'd', 'e', 'f'], 20, 40, 20), ['b', 'c']);"
		],
		defects: [
			{
				kind: 'boundary',
				from: '  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / rowHeight) - 1);',
				to: '  const last = Math.min(count - 1, Math.floor((scrollTop + height) / rowHeight));',
				neighbour: {
					from: '  const first = Math.floor(scrollTop / rowHeight);',
					to: '  const first = Math.ceil(scrollTop / rowHeight);'
				},
				symptom: { from: '  return items.slice(first, last + 1);', to: '  return items.slice(first, last);' }
			},
			{
				kind: 'boundary',
				from: '  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / rowHeight) - 1);',
				to: '  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) - 1);',
				neighbour: {
					from: '  const first = Math.floor(scrollTop / rowHeight);',
					to: '  const first = Math.max(0, Math.floor(scrollTop / rowHeight));'
				},
				symptom: {
					from: '  return items.slice(first, last + 1);',
					to: '  return items.slice(first, Math.min(last + 1, items.length));'
				}
			},
			{
				kind: 'boundary',
				from: '  return items.slice(first, last + 1);',
				to: '  return items.slice(first, last);',
				neighbour: {
					from: '  const { first, last } = visibleRange(scrollTop, height, rowHeight, items.length);',
					to: '  const { first, last } = visibleRange(scrollTop, height, rowHeight, items.length - 1);'
				},
				symptom: {
					from: '  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / rowHeight) - 1);',
					to: '  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / rowHeight));'
				}
			}
		],
		decoy: {
			from: '  const first = Math.floor(scrollTop / rowHeight);',
			to: '  const first = Math.round(scrollTop / rowHeight);'
		}
	},
	{
		lines: [
			'/**',
			' * Количество из поля ввода: целое число от 0. Число читается по ведущим цифрам, как parseInt:',
			" * '12abc' → 12; пустая строка, строка без ведущих цифр и отрицательное число — 0.",
			' */',
			'function parseQuantity(raw) {',
			'  const n = Number.parseInt(raw, 10);',
			'  return Number.isNaN(n) || n < 0 ? 0 : n;',
			'}',
			'',
			'/**',
			' * Строки корзины из формы: id — как в форме (строкой), количество — числом;',
			' * строки с количеством 0 отбрасываются.',
			' */',
			'function cartLines(form) {',
			'  return form',
			'    .map((row) => ({ id: row.id, quantity: parseQuantity(row.quantity) }))',
			'    .filter((line) => line.quantity > 0);',
			'}',
			'',
			'/**',
			' * Сумма корзины по каталогу prices — Map, где ключ — числовой id товара, значение — цена.',
			' * id в форме — запись числа без ведущих нулей, каждый такой товар есть в prices.',
			' */',
			'function cartTotal(form, prices) {',
			'  let total = 0;',
			'  for (const line of cartLines(form)) {',
			'    total += prices.get(Number(line.id)) * line.quantity;',
			'  }',
			'  return total;',
			'}'
		],
		checks: [
			'const prices = new Map([[1, 100], [2, 250]]);',
			"__eq(parseQuantity('3'), 3);",
			"__eq(parseQuantity(''), 0);",
			"__eq(parseQuantity('abc'), 0);",
			"__eq(parseQuantity('12abc'), 12);",
			"__eq(cartLines([{ id: '2', quantity: '0' }, { id: '1', quantity: '3' }]), [{ id: '1', quantity: 3 }]);",
			"__eq(cartTotal([{ id: '1', quantity: '2' }, { id: '2', quantity: 'x' }, { id: '2', quantity: '1' }], prices), 450);"
		],
		defects: [
			{
				kind: 'coercion',
				from: '    total += prices.get(Number(line.id)) * line.quantity;',
				to: '    total += prices.get(line.id) * line.quantity;',
				neighbour: { from: '  let total = 0;', to: '  let total = Number(0);' },
				symptom: {
					from: '    .map((row) => ({ id: row.id, quantity: parseQuantity(row.quantity) }))',
					to: '    .map((row) => ({ id: Number(row.id), quantity: parseQuantity(row.quantity) }))'
				}
			},
			{
				kind: 'coercion',
				from: '  return Number.isNaN(n) || n < 0 ? 0 : n;',
				to: '  return n == NaN || n < 0 ? 0 : n;',
				neighbour: { from: 'function parseQuantity(raw) {', to: "function parseQuantity(raw = '') {" },
				alternatives: [
					{ from: '  const n = Number.parseInt(raw, 10);', to: '  const n = Number.parseInt(raw, 10) || 0;' }
				],
				symptom: {
					from: '    .filter((line) => line.quantity > 0);',
					to: '    .filter((line) => line.quantity > 0 && !Number.isNaN(line.quantity));'
				}
			}
		],
		decoy: {
			from: '    total += prices.get(Number(line.id)) * line.quantity;',
			to: '    total += (prices.get(Number(line.id)) ?? 0) * line.quantity;'
		}
	},
	{
		lines: [
			'/**',
			' * Числовые id карточек из атрибута data-id (строка) по возрастанию.',
			' */',
			'function sortedIds(cards) {',
			'  return cards.map((card) => Number(card.dataset.id)).sort((a, b) => a - b);',
			'}',
			'',
			'/**',
			' * Наибольший id карточек; для пустого списка — 0.',
			' */',
			'function maxId(cards) {',
			'  const ids = sortedIds(cards);',
			'  return ids.length === 0 ? 0 : ids[ids.length - 1];',
			'}'
		],
		checks: [
			"const cards = [{ dataset: { id: '10' } }, { dataset: { id: '9' } }, { dataset: { id: '100' } }];",
			'__eq(sortedIds(cards), [9, 10, 100]);',
			'__eq(maxId(cards), 100);',
			'__eq(maxId([]), 0);'
		],
		defects: [
			{
				kind: 'coercion',
				from: '  return cards.map((card) => Number(card.dataset.id)).sort((a, b) => a - b);',
				to: '  return cards.map((card) => Number(card.dataset.id)).sort();',
				neighbour: { from: 'function sortedIds(cards) {', to: 'function sortedIds(cards = []) {' },
				symptom: {
					from: '  return ids.length === 0 ? 0 : ids[ids.length - 1];',
					to: '  return ids.length === 0 ? 0 : Math.max(...ids);'
				}
			},
			{
				kind: 'coercion',
				from: '  return cards.map((card) => Number(card.dataset.id)).sort((a, b) => a - b);',
				to: '  return cards.map((card) => card.dataset.id).sort((a, b) => a - b);',
				neighbour: { from: 'function sortedIds(cards) {', to: 'function sortedIds(cards = []) {' },
				symptom: { from: '  const ids = sortedIds(cards);', to: '  const ids = sortedIds(cards).map(Number);' }
			}
		],
		decoy: { from: '  const ids = sortedIds(cards);', to: '  const ids = [...sortedIds(cards)];' }
	},
	{
		lines: [
			'/**',
			' * Задачи по убыванию приоритета, при равном приоритете — в исходном порядке;',
			' * исходный массив не меняется.',
			' */',
			'function byPriority(tasks) {',
			'  const sorted = [...tasks].sort((a, b) => b.priority - a.priority);',
			'  return sorted;',
			'}',
			'',
			'/**',
			' * Id первых n задач по приоритету.',
			' */',
			'function topIds(tasks, n) {',
			'  return byPriority(tasks).slice(0, n).map((t) => t.id);',
			'}',
			'',
			'/**',
			' * Сводка для шапки: id первых n задач по приоритету и id самой ранней задачи',
			' * (первой в списке). Список tasks не пуст и не меняется; n — целое число от 0.',
			' */',
			'function summary(tasks, n) {',
			'  const top = topIds(tasks, n);',
			'  return { top, earliest: tasks[0].id };',
			'}'
		],
		checks: [
			"const tasks = [{ id: 'a', priority: 1 }, { id: 'b', priority: 3 }, { id: 'c', priority: 2 }];",
			"__eq(byPriority(tasks).map((t) => t.id), ['b', 'c', 'a']);",
			"__eq(tasks.map((t) => t.id), ['a', 'b', 'c']);",
			"__eq(summary(tasks, 2), { top: ['b', 'c'], earliest: 'a' });",
			'__eq(tasks.length, 3);'
		],
		defects: [
			{
				kind: 'mutation',
				from: '  const sorted = [...tasks].sort((a, b) => b.priority - a.priority);',
				to: '  const sorted = tasks.sort((a, b) => b.priority - a.priority);',
				neighbour: { from: '  return sorted;', to: '  return [...sorted];' },
				alternatives: [{ from: 'function byPriority(tasks) {', to: 'function byPriority([...tasks]) {' }],
				symptom: {
					from: '  return byPriority(tasks).slice(0, n).map((t) => t.id);',
					to: '  return byPriority([...tasks]).slice(0, n).map((t) => t.id);'
				}
			},
			{
				kind: 'mutation',
				from: '  return { top, earliest: tasks[0].id };',
				to: '  return { top, earliest: tasks.shift().id };',
				neighbour: { from: '  const top = topIds(tasks, n);', to: '  const top = topIds([...tasks], n);' },
				symptom: {
					from: '  const sorted = [...tasks].sort((a, b) => b.priority - a.priority);',
					to: '  const sorted = [...tasks].sort((a, b) => b.priority - a.priority || 0);'
				},
				alternatives: [{ from: 'function summary(tasks, n) {', to: 'function summary([...tasks], n) {' }]
			}
		],
		decoy: {
			from: '  return byPriority(tasks).slice(0, n).map((t) => t.id);',
			to: '  return byPriority(tasks).slice(0, n + 1).map((t) => t.id);'
		}
	},
	{
		lines: [
			'/**',
			' * true, если value — обычный объект (не массив и не null), иначе false.',
			' */',
			'function isPlainObject(value) {',
			"  return typeof value === 'object' && value !== null && !Array.isArray(value);",
			'}',
			'',
			'/**',
			' * Глубокое слияние: значения patch поверх base, вложенные обычные объекты сливаются.',
			" * Значения 0, '' и false из patch применяются, undefined пропускается. base и patch не меняются.",
			' */',
			'function deepMerge(base, patch) {',
			'  const result = { ...base };',
			'  for (const [key, value] of Object.entries(patch)) {',
			'    if (isPlainObject(result[key]) && isPlainObject(value)) {',
			'      result[key] = deepMerge(result[key], value);',
			'    } else if (value !== undefined) {',
			'      result[key] = value;',
			'    }',
			'  }',
			'  return result;',
			'}'
		],
		checks: [
			"const base = { theme: 'light', layout: { cols: 3, dense: true }, volume: 5, tags: ['a'] };",
			'const merged = deepMerge(base, { layout: { dense: false }, volume: 0, theme: undefined, tags: [] });',
			"__eq(merged, { theme: 'light', layout: { cols: 3, dense: false }, volume: 0, tags: [] });",
			"__eq(base, { theme: 'light', layout: { cols: 3, dense: true }, volume: 5, tags: ['a'] });",
			'__eq(isPlainObject([]), false);',
			'__eq(isPlainObject(null), false);',
			'__eq(isPlainObject({ a: 1 }), true);'
		],
		defects: [
			{
				kind: 'mutation',
				from: '  const result = { ...base };',
				to: '  const result = base;',
				alternatives: [{ from: 'function deepMerge(base, patch) {', to: 'function deepMerge({ ...base }, patch) {' }],
				neighbour: {
					from: '      result[key] = deepMerge(result[key], value);',
					to: '      result[key] = deepMerge({ ...result[key] }, value);'
				},
				symptom: {
					from: "  return typeof value === 'object' && value !== null && !Array.isArray(value);",
					to: "  return Object.prototype.toString.call(value) === '[object Object]';"
				}
			},
			{
				kind: 'falsy',
				from: '    } else if (value !== undefined) {',
				to: '    } else if (value) {',
				neighbour: {
					from: '    if (isPlainObject(result[key]) && isPlainObject(value)) {',
					to: '    if (isPlainObject(value)) {'
				},
				symptom: {
					from: "  return typeof value === 'object' && value !== null && !Array.isArray(value);",
					to: "  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);"
				}
			},
			{
				kind: 'falsy',
				from: "  return typeof value === 'object' && value !== null && !Array.isArray(value);",
				to: "  return value && typeof value === 'object' && !Array.isArray(value);",
				neighbour: { from: 'function isPlainObject(value) {', to: 'function isPlainObject(value = {}) {' },
				symptom: {
					from: '    if (isPlainObject(result[key]) && isPlainObject(value)) {',
					to: '    if (isPlainObject(result[key]) === true && isPlainObject(value) === true) {'
				}
			}
		],
		decoy: { from: '    } else if (value !== undefined) {', to: '    } else if (value !== null) {' }
	},
	{
		lines: [
			'/**',
			" * Значение поля для карточки: null и undefined — '—', остальное — строкой (0 → '0', false → 'false').",
			' */',
			'function display(value) {',
			"  return value === null || value === undefined ? '—' : String(value);",
			'}',
			'',
			'/**',
			' * Строки карточки «название: значение» только для заданных полей (не null и не undefined),',
			' * в порядке полей.',
			' */',
			'function cardLines(fields) {',
			'  return Object.entries(fields)',
			'    .filter(([, value]) => value != null)',
			"    .map(([name, value]) => name + ': ' + display(value));",
			'}'
		],
		checks: [
			"__eq(display(0), '0');",
			"__eq(display(null), '—');",
			"__eq(display(false), 'false');",
			"__eq(cardLines({ rooms: 0, floor: null, area: 54, balcony: false, note: undefined }), ['rooms: 0', 'area: 54', 'balcony: false']);"
		],
		defects: [
			{
				kind: 'falsy',
				from: "  return value === null || value === undefined ? '—' : String(value);",
				to: "  return value ? String(value) : '—';",
				neighbour: { from: 'function display(value) {', to: 'function display(value = null) {' },
				symptom: {
					from: "    .map(([name, value]) => name + ': ' + display(value));",
					to: "    .map(([name, value]) => name + ': ' + (display(value) || String(value)));"
				}
			},
			{
				kind: 'falsy',
				from: '    .filter(([, value]) => value != null)',
				to: '    .filter(([, value]) => value)',
				neighbour: {
					from: "    .map(([name, value]) => name + ': ' + display(value));",
					to: "    .map(([name, value]) => name + ': ' + String(value));"
				},
				symptom: {
					from: "  return value === null || value === undefined ? '—' : String(value);",
					to: "  return value == null ? '—' : String(value);"
				}
			}
		],
		decoy: { from: '    .filter(([, value]) => value != null)', to: '    .filter(([, value]) => value !== null)' }
	}
];

/** The index of the only line of a unit equal to `text`; a library that breaks this is a programming error. */
function lineIndex(unit: Unit, text: string): number {
	const found = unit.lines.flatMap((line, i) => (line === text ? [i] : []));
	if (found.length !== 1)
		throw new Error(`${descriptor.key}: line ${JSON.stringify(text)} occurs ${found.length} times`);
	return found[0] ?? 0;
}

for (const unit of [...INTERN, ...JUNIOR]) {
	lineIndex(unit, unit.decoy.from);
	for (const d of unit.defects) {
		const at = lineIndex(unit, d.from);
		const traps = [d.neighbour, ...(d.symptom ? [d.symptom] : [])].map((c) => lineIndex(unit, c.from));
		if (traps.includes(at)) throw new Error(`${descriptor.key}: a trap on the defect line ${d.from}`);
		for (const a of d.alternatives ?? []) {
			const alt = lineIndex(unit, a.from);
			if (alt === at || traps.includes(alt))
				throw new Error(`${descriptor.key}: an accepted line ${a.from} is the defect or a trap`);
		}
	}
}

const MODULE_TITLES = [
	'Утилиты витрины интернет-магазина',
	'Вспомогательные функции личного кабинета',
	'Общие функции каталога',
	'Помощники форм и списков'
];
const HEADER_CONSTANTS = [
	"const LOCALE = 'ru-RU';",
	"const CURRENCY = 'RUB';",
	'const DEBOUNCE_MS = 300;',
	"const API_BASE = '/api/v2';",
	'const MAX_TAGS = 10;',
	"const STORAGE_KEY = 'app-state';"
];

const CHECK_PRELUDE = [
	// Objects are compared regardless of the order of their keys; arrays keep their order.
	'function __norm(value) {',
	'  if (Array.isArray(value)) return value.map(__norm);',
	"  if (value === null || typeof value !== 'object' || value instanceof Date) return value;",
	'  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, __norm(value[key])]));',
	'}',
	'function __eq(actual, expected) {',
	'  const a = JSON.stringify(__norm(actual));',
	'  const e = JSON.stringify(__norm(expected));',
	"  if (a !== e) throw new Error(a + ' !== ' + e);",
	'}'
];

interface Composed {
	source: string;
	check: string;
	line: number;
	fix: string;
	neighbour: { line: number; replacement: string };
	other: { line: number; replacement: string };
	symptom: { line: number; replacement: string } | null;
	alternatives: { line: number; fix: string }[];
}

function compose(rng: Rng, library: readonly Unit[], kind: string, contextCount: number): Composed {
	const candidates = library.flatMap((unit) =>
		unit.defects.filter((d) => d.kind === kind).map((defect) => ({ unit, defect }))
	);
	const { unit: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((u) => u !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A header of random length: a comment and constants, so the defect's line number carries no hint.
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 4));
	const lines: string[] = [`// ${rng.pick(MODULE_TITLES)}.`, ...(constants.length ? ['', ...constants] : []), ''];
	const offsets = new Map<Unit, number>();
	for (const unit of order) {
		offsets.set(unit, lines.length);
		unit.lines.forEach((line, i) =>
			lines.push(unit === buggy && i === lineIndex(buggy, defect.from) ? defect.to : line)
		);
		lines.push('');
	}
	lines.pop();
	const at = (unit: Unit, text: string) => (offsets.get(unit) ?? 0) + lineIndex(unit, text) + 1;
	const firstContext = order.find((u) => u !== buggy) ?? buggy;
	const checks = order.flatMap((unit) => ['  {', ...unit.checks.map((c) => `    ${c}`), '  }']);
	const check = [
		...CHECK_PRELUDE,
		'try {',
		...checks,
		"  console.log('ok');",
		'} catch (error) {',
		"  console.log('fail', error.message);",
		'}'
	].join('\n');
	return {
		source: lines.join('\n'),
		check,
		line: at(buggy, defect.from),
		fix: defect.from,
		neighbour: { line: at(buggy, defect.neighbour.from), replacement: defect.neighbour.to },
		other: { line: at(firstContext, firstContext.decoy.from), replacement: firstContext.decoy.to },
		symptom: defect.symptom ? { line: at(buggy, defect.symptom.from), replacement: defect.symptom.to } : null,
		alternatives: (defect.alternatives ?? []).map((c) => ({ line: at(buggy, c.from), fix: c.to }))
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p = input.grade === 'intern' ? compose(rng, INTERN, input.classId, 3) : compose(rng, JUNIOR, input.classId, 2);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль утилит фронтенда на JavaScript. У каждой функции в комментарии JSDoc записана её спецификация, ' +
				'включая допустимые значения аргументов. Строковые ключи и id в данных — обычные имена: не совпадают с именами ' +
				'свойств `Object.prototype` (`__proto__`, `constructor`, `toString` и т. п.). В модуле один дефект: одна строка ' +
				'нарушает спецификацию своей функции. ' +
				'Введите номер строки, замена которой одной инструкцией восстанавливает спецификацию всех функций ' +
				'(нумерация с 1). Если исправить можно в нескольких строках — засчитывается любая из них, где замена одной ' +
				'инструкцией восстанавливает спецификацию. Исправление — одна простая инструкция того же вида, что ' +
				'исправляемая строка: не добавляйте конструкций, которых в ней нет (стрелочные функции, циклы, обёртки, ' +
				'новые функции), и не переносите в неё логику из другой строки.',
			code: { language: 'javascript', source: p.source }
		},
		answer: {
			kind: 'line_no',
			value: p.line,
			...(p.alternatives.length ? { alternatives: p.alternatives.map((a) => a.line) } : {})
		}
	});
	const traps = [p.neighbour, p.other, ...(p.symptom ? [p.symptom] : [])];
	const lineAnswer = (line: number) => ({ kind: 'answer' as const, answer: { kind: 'line_no' as const, value: line } });
	return {
		instance,
		reference: () => {
			const main = nodeDefectProbe({
				source: p.source,
				language: 'javascript',
				check: p.check,
				line: p.line,
				fix: p.fix,
				distractors: traps
			});
			// Each accepted alternative is proven by its own probe (the defect fails, the alternative fix passes); the
			// probes run one after another and the last one prints the defect line.
			const proofs = p.alternatives.map((a) => {
				const probe = nodeDefectProbe({
					source: p.source,
					language: 'javascript',
					check: p.check,
					line: a.line,
					fix: a.fix,
					distractors: []
				});
				if (probe.kind !== 'output') throw new Error(`${descriptor.key}: a defect probe prints its line`);
				const body = probe.source.split('\n');
				if (body.at(-1) !== `print(${a.line})`) throw new Error(`${descriptor.key}: unexpected defect probe`);
				return body.slice(0, -1).join('\n');
			});
			return main.kind === 'output' && proofs.length ? { ...main, source: [...proofs, main.source].join('\n') } : main;
		},
		wrong: () => ({
			'neighbour-line': lineAnswer(p.neighbour.line),
			'other-function': lineAnswer(p.other.line),
			'caller-line': p.symptom ? lineAnswer(p.symptom.line) : null
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
