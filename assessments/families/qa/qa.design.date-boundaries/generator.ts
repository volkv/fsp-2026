// Boundary values of dates and times: the last day (or minute) a rule still holds and the first it does not — a
// promotion with inclusive dates, a term in days counted from the next day, full years of age, a term in months that
// ends on the matching date or the last day of a shorter month, a birthday on 29 February, a window in hours and a
// term in working days with weekends and holidays.
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

/** Days since 1970-01-01 (UTC). */
type Day = number;

const DAY_MS = 86_400_000;
const dayOf = (y: number, m: number, d: number): Day => Date.UTC(y, m - 1, d) / DAY_MS;
const ymd = (day: Day): [number, number, number] => {
	const date = new Date(day * DAY_MS);
	return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
};
const iso = (day: Day): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isoMinute = (minute: number): string => new Date(minute * 60_000).toISOString().slice(0, 16);
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = (day: Day): number => new Date(day * DAY_MS).getUTCDay();

const MONTHS = [
	'января',
	'февраля',
	'марта',
	'апреля',
	'мая',
	'июня',
	'июля',
	'августа',
	'сентября',
	'октября',
	'ноября',
	'декабря'
];
const words = (day: Day): string => {
	const [y, m, d] = ymd(day);
	return `${d} ${MONTHS[m - 1] ?? ''} ${y}`;
};

type Kind = 'promo' | 'within-days' | 'age' | 'months' | 'leap-age' | 'month-end' | 'hours' | 'business-days';

interface Params {
	kind: Kind;
	/** The start: a day, or for `hours` a minute since the epoch. */
	start: number;
	end: Day | null;
	/** Days, months, years, hours or working days. */
	amount: number;
	/** Birthday on 29 February: which day counts in a year without it. */
	leapRule: 'feb28' | 'mar1' | null;
	holidays: Day[];
	/** `leap-age`: the second user, born next to 29 February; `month-end`: the start of the second subscription. */
	other: Day | null;
	/** `month-end`: the months of the second subscription. */
	otherAmount: number;
	plot: string;
}

interface Rules {
	endExclusive: boolean;
	insideOnly: boolean;
	countFromEvent: boolean;
	ageDayAfter: boolean;
	ageYearOnly: boolean;
	month30: boolean;
	monthOverflow: boolean;
	leapOther: boolean;
	hoursAsDays: boolean;
	endInclusive: boolean;
	calendarDays: boolean;
	holidaysIgnored: boolean;
}

const RIGHT: Rules = {
	endExclusive: false,
	insideOnly: false,
	countFromEvent: false,
	ageDayAfter: false,
	ageYearOnly: false,
	month30: false,
	monthOverflow: false,
	leapOther: false,
	hoursAsDays: false,
	endInclusive: false,
	calendarDays: false,
	holidaysIgnored: false
};

/** The matching date `months` later; a missing day is the last day of the month (or overflows, as a misconception). */
function addMonths(day: Day, months: number, rules: Rules): Day {
	if (rules.month30) return day + 30 * months;
	const [y, m, d] = ymd(day);
	const total = y * 12 + (m - 1) + months;
	const ty = Math.floor(total / 12);
	const tm = (total % 12) + 1;
	if (rules.monthOverflow) return dayOf(ty, tm, d);
	return dayOf(ty, tm, Math.min(d, daysIn(ty, tm)));
}

/** The day a person born on `birth` turns `years`. */
function birthday(birth: Day, years: number, p: Params, rules: Rules): Day {
	const [y, m, d] = ymd(birth);
	const ty = y + years;
	if (rules.ageYearOnly) return dayOf(ty, 1, 1);
	if (m === 2 && d === 29 && daysIn(ty, 2) === 28) {
		const rule = rules.leapOther ? (p.leapRule === 'feb28' ? 'mar1' : 'feb28') : p.leapRule;
		return rule === 'feb28' ? dayOf(ty, 2, 28) : dayOf(ty, 3, 1);
	}
	return dayOf(ty, m, d);
}

/** The boundary values, as ISO strings. */
function solve(p: Params, rules: Rules): string[] {
	switch (p.kind) {
		case 'promo': {
			const end = p.end ?? 0;
			const lastIn = rules.endExclusive ? end - 1 : end;
			const values = rules.insideOnly ? [p.start, lastIn] : [p.start - 1, p.start, lastIn, lastIn + 1];
			return values.map(iso);
		}
		case 'within-days': {
			const last = p.start + p.amount - (rules.countFromEvent ? 1 : 0);
			return [last, last + 1].map(iso);
		}
		case 'age':
		case 'leap-age': {
			return [p.start, ...(p.other === null ? [] : [p.other])].flatMap((birth) => {
				const first = birthday(birth, p.amount, p, rules) + (rules.ageDayAfter ? 1 : 0);
				return [first - 1, first].map(iso);
			});
		}
		case 'months':
		case 'month-end': {
			const terms: [Day, number][] = [
				[p.start, p.amount],
				...(p.other === null ? [] : [[p.other, p.otherAmount] as [Day, number]])
			];
			return terms.flatMap(([start, months]) => {
				const last = addMonths(start, months, rules);
				return [last, last + 1].map(iso);
			});
		}
		case 'hours': {
			if (rules.hoursAsDays) {
				const lastDay = Math.floor(p.start / 1440) + p.amount / 24;
				return [lastDay * 1440 + 1439, (lastDay + 1) * 1440].map(isoMinute);
			}
			const end = p.start + p.amount * 60 + (rules.endInclusive ? 1 : 0);
			return [end - 1, end].map(isoMinute);
		}
		case 'business-days': {
			let day = rules.countFromEvent ? p.start - 1 : p.start;
			if (rules.calendarDays) day += p.amount;
			else {
				for (let left = p.amount; left > 0;) {
					day += 1;
					const wd = weekday(day);
					const off = wd === 0 || wd === 6 || (!rules.holidaysIgnored && p.holidays.includes(day));
					if (!off) left -= 1;
				}
			}
			return [day, day + 1].map(iso);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const randomDay = (rng: Rng, fromYear: number, toYear: number): Day =>
	rng.int(dayOf(fromYear, 1, 1), dayOf(toYear, 12, 31));

function scenario(rng: Rng, grade: string, classId: string): Params {
	const base: Omit<Params, 'kind' | 'start'> = {
		end: null,
		amount: 0,
		leapRule: null,
		holidays: [],
		other: null,
		otherAmount: 0,
		plot: ''
	};
	if (grade === 'intern') {
		if (classId === 'promo') {
			const start = randomDay(rng, 2025, 2028);
			return {
				...base,
				kind: 'promo',
				start,
				end: start + rng.int(6, 75),
				plot: rng.pick(['Акция «Скидка 20 % на всё»', 'Распродажа электроники', 'Кешбэк 10 % за оплату картой'])
			};
		}
		if (classId === 'within-days')
			return {
				...base,
				kind: 'within-days',
				start: randomDay(rng, 2025, 2028),
				amount: rng.pick([7, 10, 14, 21, 30]),
				plot: rng.pick(['возврат товара', 'обмен товара', 'отказ от услуги'])
			};
		if (classId === 'age') {
			const amount = rng.pick([14, 16, 18, 21]);
			let birth = randomDay(rng, 1990, 2012);
			const [, m, d] = ymd(birth);
			if (m === 2 && d === 29) birth += 1;
			return { ...base, kind: 'age', start: birth, amount, plot: '' };
		}
		let start = randomDay(rng, 2025, 2028);
		const [y, m, d] = ymd(start);
		if (d > 28) start = dayOf(y, m, rng.int(1, 28));
		return { ...base, kind: 'months', start, amount: rng.int(1, 12), plot: '' };
	}
	if (classId === 'leap-age') {
		const leapYears = [1980, 1984, 1988, 1992, 1996, 2000, 2004, 2008, 2012];
		const birth = dayOf(rng.pick(leapYears), 2, 29);
		const otherYear = rng.int(1980, 2012);
		return {
			...base,
			kind: 'leap-age',
			start: birth,
			other: rng.bool() ? dayOf(otherYear, 2, 28) : dayOf(otherYear, 3, 1),
			// Ages that land in a year without 29 February.
			amount: rng.pick([14, 18, 21, 22, 23, 25, 26, 27, 29, 30]),
			leapRule: rng.pick(['feb28', 'mar1'] as const),
			plot: ''
		};
	}
	if (classId === 'month-end') {
		// Two subscriptions, each from the 29th to the 31st of a month.
		const lateDay = (): Day => {
			const y = rng.int(2025, 2034);
			const m = rng.int(1, 12);
			return dayOf(y, m, rng.int(Math.min(29, daysIn(y, m)), daysIn(y, m)));
		};
		const start = lateDay();
		let other = lateDay();
		if (other === start) other += 1;
		return { ...base, kind: 'month-end', start, amount: rng.int(1, 13), other, otherAmount: rng.int(1, 13), plot: '' };
	}
	if (classId === 'hours') {
		const day = randomDay(rng, 2025, 2028);
		return {
			...base,
			kind: 'hours',
			start: day * 1440 + rng.int(0, 23) * 60 + rng.pick([0, 5, 10, 15, 20, 30, 40, 45, 50]),
			amount: rng.pick([24, 48, 72, 96, 120]),
			plot: rng.pick(Object.keys(HOUR_PLOTS))
		};
	}
	const start = randomDay(rng, 2025, 2028);
	const holidays = [...new Set(Array.from({ length: rng.int(1, 3) }, () => start + rng.int(1, 12)))]
		.filter((h) => weekday(h) !== 0 && weekday(h) !== 6)
		.sort((a, b) => a - b);
	return { ...base, kind: 'business-days', start, amount: rng.int(3, 10), holidays, plot: '' };
}

function describe(p: Params): string {
	const dates =
		'Введите даты в формате ГГГГ-ММ-ДД по одной в строке, в любом порядке. Например:\n\n```\n2027-01-31\n2027-02-01\n```';
	switch (p.kind) {
		case 'promo':
			return [
				`${p.plot} действует с ${words(p.start)} по ${words(p.end ?? 0)} включительно (даты — по календарю магазина).`,
				'',
				'Тестировщик проверяет даты двухточечным анализом граничных значений: у каждой границы периода — последний день по одну её сторону и первый по другую.',
				'',
				`Какие даты войдут в набор? ${dates}`
			].join('\n');
		case 'within-days':
			return [
				`Правило магазина: ${p.plot} — в течение ${p.amount} дней. Срок начинается на следующий день после дня покупки и заканчивается в конце своего последнего дня.`,
				'',
				`Покупка совершена ${words(p.start)}. Какой день — последний, когда ${p.plot} ещё возможен, и какой — первый, когда уже нет? ${dates}`
			].join('\n');
		case 'age':
			return [
				`Сервис разрешает регистрацию с ${p.amount} полных лет. Полных лет становится ${p.amount} в день рождения.`,
				'',
				`Пользователь родился ${words(p.start)}. Какой день — последний, когда регистрация ещё запрещена, и какой — первый, когда она разрешена? ${dates}`
			].join('\n');
		case 'leap-age':
			return [
				`Сервис разрешает регистрацию с ${p.amount} полных лет. Полных лет становится ${p.amount} в день рождения. Для родившихся 29 февраля в году без этого числа днём рождения считается ${p.leapRule === 'feb28' ? '28 февраля' : '1 марта'}.`,
				'',
				`Пользователи родились ${words(p.start)} и ${words(p.other ?? 0)}. Для каждого: какой день — последний, когда регистрация ещё запрещена, и какой — первый, когда она разрешена? ${dates}`
			].join('\n');
		case 'months':
			return [
				`Подписка оформлена ${words(p.start)} на ${p.amount} ${monthsWord(p.amount)}. Срок в месяцах истекает в то же число последнего месяца срока, этот день — последний день доступа.`,
				'',
				`Какой день — последний с доступом и какой — первый без доступа? ${dates}`
			].join('\n');
		case 'month-end':
			return [
				'Срок подписки в месяцах истекает в то же число последнего месяца срока, этот день — последний день доступа. Если в последнем месяце такого числа нет, срок истекает в последний день этого месяца.',
				'',
				`Оформлены две подписки: ${words(p.start)} на ${p.amount} ${monthsWord(p.amount)} и ${words(p.other ?? 0)} на ${p.otherAmount} ${monthsWord(p.otherAmount)}. Для каждой: какой день — последний с доступом и какой — первый без доступа? ${dates}`
			].join('\n');
		case 'hours':
			return [
				`Правило сервиса: ${p.plot} возможно в течение ${p.amount} ${hoursWord(p.amount, false)} с момента ${HOUR_PLOTS[p.plot]?.[0] ?? ''}. Ровно через ${p.amount} ${hoursWord(p.amount, true)} это уже нельзя. Всё время — московское, переходов на летнее время нет; система считает время с точностью до минуты.`,
				'',
				`${HOUR_PLOTS[p.plot]?.[1] ?? ''} ${words(Math.floor(p.start / 1440))} в ${isoMinute(p.start).slice(11)}. Какая минута — последняя, когда ${p.plot} ещё возможно, и какая — первая, когда уже нет? Введите моменты в формате ГГГГ-ММ-ДДTЧЧ:ММ по одному в строке, в любом порядке. Например:`,
				'',
				'```',
				'2027-01-31T23:59',
				'2027-02-01T00:00',
				'```'
			].join('\n');
		case 'business-days':
			return [
				`Претензию нужно рассмотреть в течение ${p.amount} рабочих дней. Срок начинается на следующий день после дня получения претензии; рабочие дни — с понедельника по пятницу, кроме праздников. Праздники в этот период: ${p.holidays.length > 0 ? p.holidays.map(words).join(', ') : 'нет'}. Первый день просрочки — следующий календарный день после последнего дня срока, даже если он выходной или праздник.`,
				'',
				`Претензия получена ${words(p.start)} (${WEEKDAYS[weekday(p.start)] ?? ''}). Какой день — последний день срока и какой — первый день просрочки? ${dates}`
			].join('\n');
	}
}

/** A window in hours: the action, the event it counts from and how the event is reported. */
const HOUR_PLOTS: Readonly<Record<string, readonly [string, string]>> = {
	'изменение заказа': ['оформления заказа', 'Заказ оформлен'],
	'бесплатное аннулирование брони': ['оформления брони', 'Бронь оформлена'],
	'оспаривание платежа': ['проведения платежа', 'Платёж проведён']
};

/** «в течение N часов» (genitive) and «через N часа» (accusative). */
function hoursWord(n: number, accusative: boolean): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	const teen = mod100 >= 11 && mod100 <= 14;
	if (mod10 === 1 && !teen) return accusative ? 'час' : 'часа';
	if (accusative && mod10 >= 2 && mod10 <= 4 && !teen) return 'часа';
	return 'часов';
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function monthsWord(n: number): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return 'месяц';
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'месяца';
	return 'месяцев';
}

const PYTHON_REFERENCE = `import calendar
import json
from datetime import date, datetime, timedelta

p = json.loads(input())
kind = p["kind"]
one = timedelta(days=1)


def day(s):
    return date.fromisoformat(s)


def plus_months(d, n):
    y, m = divmod(d.year * 12 + d.month - 1 + n, 12)
    return date(y, m + 1, min(d.day, calendar.monthrange(y, m + 1)[1]))


if kind == "promo":
    a, b = day(p["start"]), day(p["end"])
    out = [a - one, a, b, b + one]
elif kind == "within-days":
    last = day(p["start"]) + timedelta(days=p["amount"])
    out = [last, last + one]
elif kind in ("age", "leap-age"):
    out = []
    for s in [p["start"]] + ([p["other"]] if p["other"] else []):
        b = day(s)
        y = b.year + p["amount"]
        if b.month == 2 and b.day == 29 and not calendar.isleap(y):
            first = date(y, 2, 28) if p["leapRule"] == "feb28" else date(y, 3, 1)
        else:
            first = date(y, b.month, b.day)
        out += [first - one, first]
elif kind in ("months", "month-end"):
    out = []
    terms = [(p["start"], p["amount"])] + ([(p["other"], p["otherAmount"])] if p["other"] else [])
    for s, n in terms:
        last = plus_months(day(s), n)
        out += [last, last + one]
elif kind == "hours":
    end = datetime.fromisoformat(p["start"]) + timedelta(hours=p["amount"])
    out = [end - timedelta(minutes=1), end]
else:
    d = day(p["start"])
    holidays = {day(h) for h in p["holidays"]}
    left = p["amount"]
    while left:
        d += one
        if d.weekday() < 5 and d not in holidays:
            left -= 1
    out = [d, d + one]
for v in sorted(set(out)):
    print(v.isoformat(timespec="minutes") if isinstance(v, datetime) else v.isoformat())
`;

const WRONG: Record<string, Partial<Rules>> = {
	'end-exclusive': { endExclusive: true },
	'inside-only': { insideOnly: true },
	'count-from-event': { countFromEvent: true },
	'age-day-after': { ageDayAfter: true },
	'age-year-only': { ageYearOnly: true },
	'month-30-days': { month30: true },
	'month-overflow': { monthOverflow: true },
	'leap-other-day': { leapOther: true },
	'hours-as-days': { hoursAsDays: true },
	'end-inclusive': { endInclusive: true },
	'calendar-days': { calendarDays: true },
	'holidays-ignored': { holidaysIgnored: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/promo': ['end-exclusive', 'inside-only'],
	'intern/within-days': ['count-from-event'],
	'intern/age': ['age-day-after', 'age-year-only'],
	'intern/months': ['month-30-days'],
	'junior/leap-age': ['leap-other-day', 'age-day-after'],
	'junior/month-end': ['month-30-days', 'month-overflow'],
	'junior/hours': ['hours-as-days', 'end-inclusive'],
	'junior/business-days': ['calendar-days', 'holidays-ignored', 'count-from-event']
};

const key = (values: readonly string[]): string => [...values].sort().join(',');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, key(value) === key(answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'set', value: [...answer].sort() }
		});
		const stdin = JSON.stringify({
			kind: p.kind,
			start: p.kind === 'hours' ? isoMinute(p.start) : iso(p.start),
			end: p.end === null ? null : iso(p.end),
			amount: p.amount,
			leapRule: p.leapRule,
			holidays: p.holidays.map(iso),
			other: p.other === null ? null : iso(p.other),
			otherAmount: p.otherAmount
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
