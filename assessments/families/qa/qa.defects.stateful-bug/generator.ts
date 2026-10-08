// A class with state (a cart with a coupon, a session, a rate limiter, an order, a retry queue, a wallet, a cache,
// an event bus, reservations), its specification in the docstring and a tester's bug report: steps to reproduce,
// expected and actual result. Exactly one line breaks the specification, and only on a certain sequence of calls; the
// tester names that line. The checks run the report's scenario and the other scenarios of the specification, so a
// patch where the bug shows (the symptom line) does not pass them. The defect's kind is the essential class; the
// order of the methods and the module header are surface.
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

/** A line of a method: the method's name and the 0-based line within it (0 is the `def` line). */
interface At {
	method: string;
	line: number;
}

interface Defect {
	kind: string;
	at: At;
	text: string;
	neighbour: At & { text: string };
	/** A patch where the bug of the report shows; it fixes the report's steps but not the specification. */
	symptom: (At & { text: string }) | null;
	/** Other lines whose one-instruction replacement also restores the specification. */
	alternatives?: (At & { text: string })[];
	report: { steps: string[]; expected: string; actual: string };
}

interface Program {
	head: string[];
	methods: { name: string; lines: string[] }[];
	checks: string[];
	defects: Defect[];
}

const CART: Program = {
	head: [
		'class Cart:',
		'    """Корзина интернет-магазина; суммы — целые рубли.',
		'    - add(sku, price, qty) добавляет qty штук; повторное добавление товара увеличивает количество,',
		'      цена — из последнего добавления.',
		'    - remove(sku) убирает товар целиком; если после этого сумма товаров меньше 1000, купон снимается',
		'      и сам не возвращается.',
		'    - apply_coupon("SAVE10") включает скидку 10 % от суммы товаров (дробная часть рубля отбрасывается',
		'      у суммы скидки, не у итога), только если',
		'      корзина не оформлена и сумма товаров не меньше 1000; иначе возвращает False и ничего не меняет.',
		'    - checkout() оформляет корзину и возвращает итог.',
		'    - items() возвращает копию позиций: её изменение не влияет на корзину.',
		'    - total() — сумма товаров минус скидка."""'
	],
	methods: [
		{
			name: '__init__',
			lines: [
				'    def __init__(self):',
				'        self._items = {}',
				'        self.coupon = None',
				'        self.closed = False'
			]
		},
		{
			name: 'add',
			lines: [
				'    def add(self, sku, price, qty=1):',
				'        _, have = self._items.get(sku, (price, 0))',
				'        self._items[sku] = (price, have + qty)'
			]
		},
		{
			name: 'subtotal',
			lines: ['    def subtotal(self):', '        return sum(price * qty for price, qty in self._items.values())']
		},
		{
			name: 'apply_coupon',
			lines: [
				'    def apply_coupon(self, code):',
				'        if self.closed or code != "SAVE10" or self.subtotal() < 1000:',
				'            return False',
				'        self.coupon = code',
				'        return True'
			]
		},
		{
			name: 'remove',
			lines: [
				'    def remove(self, sku):',
				'        self._items.pop(sku, None)',
				'        if self.subtotal() < 1000:',
				'            self.coupon = None'
			]
		},
		{
			name: 'checkout',
			lines: ['    def checkout(self):', '        self.closed = True', '        return self.total()']
		},
		{ name: 'items', lines: ['    def items(self):', '        return dict(self._items)'] },
		{
			name: 'total',
			lines: [
				'    def total(self):',
				'        subtotal = self.subtotal()',
				'        discount = subtotal * 10 // 100 if self.coupon else 0',
				'        return subtotal - discount'
			]
		}
	],
	checks: [
		'c = Cart()',
		'c.add("phone", 700)',
		'c.add("case", 400)',
		'assert c.apply_coupon("SAVE10")',
		'assert c.total() == 990',
		'c.remove("case")',
		'assert c.coupon is None and c.total() == 700',
		'c.add("case", 400)',
		'assert c.total() == 1100',
		't = Cart()',
		't.add("tv", 1000)',
		'assert t.apply_coupon("SAVE10") and t.total() == 900',
		'p = Cart()',
		'p.add("pen", 999)',
		'assert not p.apply_coupon("SAVE10") and p.total() == 999',
		'view = t.items()',
		'view["tv"] = (1, 1)',
		'assert t.total() == 900',
		't.add("tv", 1200)',
		'assert t.items() == {"tv": (1200, 2)}',
		'k = Cart()',
		'k.add("tv", 1000)',
		'assert k.checkout() == 1000',
		'assert not k.apply_coupon("SAVE10") and k.total() == 1000',
		'f = Cart()',
		'f.add("lamp", 1005)',
		'assert f.apply_coupon("SAVE10") and f.total() == 905'
	],
	defects: [
		{
			kind: 'stale-state',
			at: { method: 'remove', line: 2 },
			text: '        if not self._items:',
			neighbour: { method: 'remove', line: 1, text: '        self._items.pop(sku)' },
			symptom: {
				method: 'total',
				line: 2,
				text: '        discount = subtotal * 10 // 100 if self.coupon and subtotal >= 1000 else 0'
			},
			report: {
				steps: [
					'cart = Cart()',
					'cart.add("phone", 700)',
					'cart.add("case", 400)',
					'cart.apply_coupon("SAVE10")   # True',
					'cart.remove("case")',
					'cart.total()'
				],
				expected: '`700`: после удаления сумма меньше 1000, купон снят',
				actual: '`630`'
			}
		},
		{
			kind: 'guard',
			at: { method: 'apply_coupon', line: 1 },
			text: '        if code != "SAVE10" or self.subtotal() < 1000:',
			neighbour: { method: 'apply_coupon', line: 4, text: '        return self.coupon == code' },
			symptom: {
				method: 'total',
				line: 2,
				text: '        discount = subtotal * 10 // 100 if self.coupon and not self.closed else 0'
			},
			report: {
				steps: [
					'cart = Cart()',
					'cart.add("tv", 1000)',
					'cart.checkout()   # 1000',
					'cart.apply_coupon("SAVE10")',
					'cart.total()'
				],
				expected: '`apply_coupon` возвращает `False`, итог остаётся `1000`',
				actual: '`apply_coupon` возвращает `True`, итог `900`'
			}
		},
		{
			kind: 'boundary',
			at: { method: 'apply_coupon', line: 1 },
			text: '        if self.closed or code != "SAVE10" or self.subtotal() <= 1000:',
			neighbour: { method: 'apply_coupon', line: 3, text: '        self.coupon = "SAVE10"' },
			symptom: null,
			report: {
				steps: ['cart = Cart()', 'cart.add("tv", 1000)', 'cart.apply_coupon("SAVE10")', 'cart.total()'],
				expected: '`apply_coupon` возвращает `True`, итог `900`',
				actual: '`apply_coupon` возвращает `False`, итог `1000`'
			}
		},
		{
			kind: 'aliasing',
			at: { method: 'items', line: 1 },
			text: '        return self._items',
			neighbour: { method: 'items', line: 0, text: '    def items(self, copy=True):' },
			symptom: {
				method: 'subtotal',
				line: 1,
				text: '        return sum(price * qty for price, qty in list(self._items.values()))'
			},
			report: {
				steps: [
					'cart = Cart()',
					'cart.add("tv", 1000)',
					'view = cart.items()',
					'view["tv"] = (1, 1)   # экран меняет свою копию позиций',
					'cart.total()'
				],
				expected: '`1000`',
				actual: '`1`'
			}
		}
	]
};

const SESSION: Program = {
	head: [
		'class Session:',
		'    """Сессия пользователя; время — целые секунды, передаётся явно.',
		'    - Сессия создаётся в момент now и активна, пока now < expires_at; сначала expires_at = now + ttl.',
		'    - touch(now) продлевает активную сессию: expires_at = now + ttl, но не дальше created_at + max_age;',
		'      истёкшую сессию touch не продлевает и возвращает False.',
		'    - remaining(now) — сколько секунд сессии осталось (не меньше 0).',
		'    - roles() возвращает копию ролей; список ролей, переданный при создании, копируется."""'
	],
	methods: [
		{
			name: '__init__',
			lines: [
				'    def __init__(self, now, ttl=600, max_age=3600, roles=None):',
				'        self.created_at = now',
				'        self.ttl = ttl',
				'        self.max_age = max_age',
				'        self.expires_at = now + ttl',
				'        self._roles = list(roles or [])'
			]
		},
		{ name: 'active', lines: ['    def active(self, now):', '        return now < self.expires_at'] },
		{
			name: 'touch',
			lines: [
				'    def touch(self, now):',
				'        if not self.active(now):',
				'            return False',
				'        self.expires_at = min(now + self.ttl, self.created_at + self.max_age)',
				'        return True'
			]
		},
		{ name: 'remaining', lines: ['    def remaining(self, now):', '        return max(0, self.expires_at - now)'] },
		{ name: 'roles', lines: ['    def roles(self):', '        return list(self._roles)'] }
	],
	checks: [
		's = Session(0, ttl=600, max_age=1500, roles=["user"])',
		'assert s.active(599) and not s.active(600)',
		'assert s.touch(500) and s.expires_at == 1100',
		'assert s.active(1000) and s.remaining(1000) == 100',
		'assert s.touch(1000) and s.expires_at == 1500',
		'assert not s.active(1500)',
		'assert not s.touch(1500)',
		'e = Session(0, ttl=600)',
		'assert not e.touch(600) and not e.active(600)',
		'assert not e.touch(700) and e.expires_at == 600',
		'roles = ["user"]',
		'r = Session(0, roles=roles)',
		'roles.append("admin")',
		'assert r.roles() == ["user"]',
		'got = r.roles()',
		'got.append("root")',
		'assert r.roles() == ["user"]'
	],
	defects: [
		{
			kind: 'boundary',
			at: { method: 'active', line: 1 },
			text: '        return now <= self.expires_at',
			neighbour: { method: '__init__', line: 4, text: '        self.expires_at = ttl + now' },
			symptom: { method: 'touch', line: 1, text: '        if not self.active(now) or now == self.expires_at:' },
			report: {
				steps: ['s = Session(0, ttl=600)', 's.touch(600)', 's.expires_at'],
				expected: '`touch` возвращает `False`: в момент 600 сессия уже истекла; `expires_at` остаётся `600`',
				actual: '`touch` возвращает `True`, `expires_at` равно `1200`'
			}
		},
		{
			kind: 'stale-state',
			at: { method: 'touch', line: 3 },
			text: '        self.expires_at = min(self.created_at + self.ttl, self.created_at + self.max_age)',
			neighbour: { method: 'touch', line: 4, text: '        return self.active(now)' },
			symptom: null,
			report: {
				steps: ['s = Session(0, ttl=600)', 's.touch(500)   # True', 's.active(900)'],
				expected: '`True`: сессия продлена до 1100',
				actual: '`False`'
			}
		},
		{
			kind: 'guard',
			at: { method: 'touch', line: 1 },
			text: '        if now < self.created_at:',
			neighbour: { method: 'touch', line: 2, text: '            return None' },
			symptom: null,
			report: {
				steps: ['s = Session(0, ttl=600)', 's.touch(700)', 's.active(800)'],
				expected: '`touch` возвращает `False`, сессия остаётся истёкшей: `active(800)` — `False`',
				actual: '`touch` возвращает `True`, `active(800)` — `True` (сессия продлена до 1300)'
			}
		},
		{
			kind: 'aliasing',
			at: { method: 'roles', line: 1 },
			text: '        return self._roles',
			neighbour: { method: '__init__', line: 5, text: '        self._roles = [*(roles or [])]' },
			symptom: null,
			report: {
				steps: ['s = Session(0, roles=["user"])', 'view = s.roles()', 'view.append("root")', 's.roles()'],
				expected: '`["user"]`',
				actual: '`["user", "root"]`'
			}
		},
		{
			kind: 'aliasing',
			at: { method: '__init__', line: 5 },
			text: '        self._roles = roles or []',
			neighbour: { method: 'roles', line: 1, text: '        return self._roles[:]' },
			symptom: null,
			report: {
				steps: ['roles = ["user"]', 's = Session(0, roles=roles)', 'roles.append("admin")', 's.roles()'],
				expected: '`["user"]`',
				actual: '`["user", "admin"]`'
			}
		}
	]
};

const LIMITER: Program = {
	head: [
		'class RateLimiter:',
		'    """Лимит запросов одного клиента: не больше limit разрешённых запросов в окне длиной window секунд.',
		'    - Окно открывает первый запрос; запрос в момент now >= window_start + window открывает новое окно',
		'      с момента now, и счёт окна начинается заново.',
		'    - Запрос сверх лимита отклоняется (False) и в лимите не учитывается.',
		'    - remaining() — сколько запросов ещё можно сделать в текущем окне.',
		'    - blocked() возвращает копию списка моментов отклонённых запросов."""'
	],
	methods: [
		{
			name: '__init__',
			lines: [
				'    def __init__(self, limit=3, window=60):',
				'        self.limit = limit',
				'        self.window = window',
				'        self.window_start = None',
				'        self.count = 0',
				'        self._blocked = []'
			]
		},
		{
			name: 'allow',
			lines: [
				'    def allow(self, now):',
				'        if self.window_start is None or now >= self.window_start + self.window:',
				'            self.window_start = now',
				'            self.count = 0',
				'        if self.count >= self.limit:',
				'            self._blocked.append(now)',
				'            return False',
				'        self.count += 1',
				'        return True'
			]
		},
		{ name: 'remaining', lines: ['    def remaining(self):', '        return self.limit - self.count'] },
		{ name: 'blocked', lines: ['    def blocked(self):', '        return list(self._blocked)'] }
	],
	checks: [
		'r = RateLimiter(limit=3, window=60)',
		'assert [r.allow(t) for t in (0, 1, 2, 3)] == [True, True, True, False]',
		'assert r.allow(59) is False and r.remaining() == 0',
		'assert [r.allow(t) for t in (60, 61, 62, 63)] == [True, True, True, False]',
		'assert [r.allow(t) for t in (130, 131, 132, 133)] == [True, True, True, False]',
		'assert r.blocked() == [3, 59, 63, 133]',
		'view = r.blocked()',
		'view.clear()',
		'assert r.blocked() == [3, 59, 63, 133]'
	],
	defects: [
		{
			kind: 'boundary',
			at: { method: 'allow', line: 1 },
			text: '        if self.window_start is None or now > self.window_start + self.window:',
			neighbour: { method: 'allow', line: 3, text: '            self.count -= self.count' },
			symptom: {
				method: 'allow',
				line: 4,
				text: '        if self.count >= self.limit and now - self.window_start < self.window:'
			},
			report: {
				steps: [
					'r = RateLimiter(limit=3, window=60)',
					'r.allow(0), r.allow(1), r.allow(2)   # True, True, True',
					'r.allow(60)'
				],
				expected: '`True`: в момент 60 открывается новое окно',
				actual: '`False`'
			}
		},
		{
			kind: 'stale-state',
			at: { method: 'allow', line: 2 },
			text: '            self.window_start = now if self.window_start is None else self.window_start',
			neighbour: { method: 'allow', line: 3, text: '            self.count -= self.count' },
			symptom: null,
			report: {
				steps: [
					'r = RateLimiter(limit=3, window=60)',
					'[r.allow(t) for t in (0, 1, 2, 3)]   # [True, True, True, False]',
					'[r.allow(t) for t in (60, 61, 62)]   # [True, True, True]',
					'r.allow(63)'
				],
				expected: '`False`: в окне, открытом в 60, это четвёртый запрос',
				actual: '`True`'
			}
		},
		{
			kind: 'aliasing',
			at: { method: 'blocked', line: 1 },
			text: '        return self._blocked',
			neighbour: { method: '__init__', line: 5, text: '        self._blocked = list()' },
			symptom: null,
			report: {
				steps: [
					'r = RateLimiter(limit=1, window=60)',
					'r.allow(0), r.allow(1)   # True, False',
					'view = r.blocked()',
					'view.clear()   # экран очищает свою копию',
					'r.blocked()'
				],
				expected: '`[1]`',
				actual: '`[]`'
			}
		}
	]
};

const ORDER: Program = {
	head: [
		'class Order:',
		'    """Заказ. Статусы: new -> paid -> shipped -> delivered; отменить (cancel) можно только заказ',
		'    в статусе new или paid.',
		'    - pay(amount) допустима только из new.',
		'    - Отмена оплаченного заказа возвращает деньги: refunded = paid_amount.',
		'    - Недопустимый переход бросает ValueError, состояние не меняется.',
		'    - history() — копия списка статусов."""'
	],
	methods: [
		{
			name: '__init__',
			lines: [
				'    def __init__(self):',
				'        self.status = "new"',
				'        self.paid_amount = 0',
				'        self.refunded = 0',
				'        self._history = ["new"]'
			]
		},
		{
			name: '_move',
			lines: [
				'    def _move(self, allowed, target):',
				'        if self.status not in allowed:',
				'            raise ValueError(f"{self.status} -> {target}")',
				'        self.status = target',
				'        self._history.append(target)'
			]
		},
		{
			name: 'pay',
			lines: ['    def pay(self, amount):', '        self._move(("new",), "paid")', '        self.paid_amount = amount']
		},
		{ name: 'ship', lines: ['    def ship(self):', '        self._move(("paid",), "shipped")'] },
		{ name: 'deliver', lines: ['    def deliver(self):', '        self._move(("shipped",), "delivered")'] },
		{
			name: 'cancel',
			lines: [
				'    def cancel(self):',
				'        was_paid = self.status == "paid"',
				'        self._move(("new", "paid"), "cancelled")',
				'        if was_paid:',
				'            self.refunded = self.paid_amount'
			]
		},
		{ name: 'history', lines: ['    def history(self):', '        return list(self._history)'] }
	],
	checks: [
		'o = Order()',
		'o.pay(500)',
		'o.ship()',
		'try:',
		'    o.cancel()',
		'    raise AssertionError("cancel after ship")',
		'except ValueError:',
		'    pass',
		'assert o.status == "shipped" and o.refunded == 0',
		'o.deliver()',
		'assert o.history() == ["new", "paid", "shipped", "delivered"]',
		'p = Order()',
		'p.pay(300)',
		'try:',
		'    p.pay(450)',
		'    raise AssertionError("second payment")',
		'except ValueError:',
		'    pass',
		'assert p.paid_amount == 300',
		'p.cancel()',
		'assert p.status == "cancelled" and p.refunded == 300',
		'n = Order()',
		'n.cancel()',
		'assert n.refunded == 0',
		'view = n.history()',
		'view.append("paid")',
		'assert n.history() == ["new", "cancelled"]'
	],
	defects: [
		{
			kind: 'guard',
			at: { method: 'cancel', line: 2 },
			text: '        self._move(("new", "paid", "shipped"), "cancelled")',
			neighbour: { method: 'cancel', line: 1, text: '        was_paid = self.status in ("paid",)' },
			symptom: { method: 'cancel', line: 3, text: '        if was_paid or self.paid_amount:' },
			report: {
				steps: ['o = Order()', 'o.pay(500)', 'o.ship()', 'o.cancel()', 'o.status, o.refunded'],
				expected: '`cancel` бросает `ValueError`, статус `shipped`',
				actual: 'исключения нет, статус `cancelled`, `refunded` равно `0`'
			}
		},
		{
			kind: 'guard',
			at: { method: '_move', line: 1 },
			text: '        if self.status in ("delivered", "cancelled"):',
			neighbour: { method: '_move', line: 3, text: '        self.status = str(target)' },
			symptom: { method: 'pay', line: 2, text: '        self.paid_amount = self.paid_amount or amount' },
			report: {
				steps: ['o = Order()', 'o.pay(300)', 'o.pay(450)', 'o.paid_amount'],
				expected: 'второй `pay` бросает `ValueError`, `paid_amount` равно `300`',
				actual: 'исключения нет, `paid_amount` равно `450`'
			}
		},
		{
			kind: 'aliasing',
			at: { method: 'history', line: 1 },
			text: '        return self._history',
			neighbour: { method: '__init__', line: 4, text: '        self._history = list(["new"])' },
			symptom: null,
			report: {
				steps: ['o = Order()', 'view = o.history()', 'view.append("paid")', 'o.history()'],
				expected: '`["new"]`',
				actual: '`["new", "paid"]`'
			}
		}
	]
};

const RETRY_QUEUE: Program = {
	head: [
		'class RetryQueue:',
		'    """Очередь задач с повторами; время — целые секунды.',
		'    - put(task) ставит задачу; take(now) выдаёт первую задачу с ready_at <= now или None.',
		'      Каждая выдача задачи через take — попытка.',
		'    - fail(task, now): попытка не удалась. Если это была попытка номер max_attempts, задача уходит',
		'      в dead_letters(); иначе возвращается в очередь с ready_at = now + backoff * 2 ** (attempts - 1),',
		'      где attempts — число сделанных попыток этой задачи.',
		'    - ack(task): задача выполнена.',
		'    - dead_letters() — копия списка задач, исчерпавших попытки.',
		'    Порядок вызовов: каждая задача ставится через put один раз; после каждой выдачи задачи через take',
		'    для неё вызывается ровно один из ack и fail, других вызовов ack и fail нет."""'
	],
	methods: [
		{
			name: '__init__',
			lines: [
				'    def __init__(self, max_attempts=3, backoff=10):',
				'        self.max_attempts = max_attempts',
				'        self.backoff = backoff',
				'        self._queue = []',
				'        self._attempts = {}',
				'        self._dead = []'
			]
		},
		{
			name: 'put',
			lines: [
				'    def put(self, task, ready_at=0):',
				'        self._queue.append((ready_at, task))',
				'        self._attempts.setdefault(task, 0)'
			]
		},
		{
			name: 'take',
			lines: [
				'    def take(self, now):',
				'        for i, (ready_at, task) in enumerate(self._queue):',
				'            if ready_at <= now:',
				'                del self._queue[i]',
				'                self._attempts[task] += 1',
				'                return task',
				'        return None'
			]
		},
		{
			name: 'fail',
			lines: [
				'    def fail(self, task, now):',
				'        attempts = self._attempts[task]',
				'        if attempts >= self.max_attempts:',
				'            self._dead.append(task)',
				'            return',
				'        self.put(task, now + self.backoff * 2 ** (attempts - 1))'
			]
		},
		{ name: 'ack', lines: ['    def ack(self, task):', '        self._attempts.pop(task, None)'] },
		{ name: 'dead_letters', lines: ['    def dead_letters(self):', '        return list(self._dead)'] }
	],
	checks: [
		'q = RetryQueue(max_attempts=3, backoff=10)',
		'q.put("a")',
		'assert q.take(0) == "a"',
		'q.fail("a", 0)',
		'assert q.take(9) is None',
		'assert q.take(10) == "a"',
		'q.fail("a", 10)',
		'assert q.take(29) is None',
		'assert q.take(30) == "a"',
		'q.fail("a", 30)',
		'assert q.take(1000) is None',
		'assert q.dead_letters() == ["a"]',
		'q.put("b")',
		'assert q.take(0) == "b"',
		'q.ack("b")',
		'assert q.take(1000) is None',
		'view = q.dead_letters()',
		'view.append("x")',
		'assert q.dead_letters() == ["a"]'
	],
	defects: [
		{
			kind: 'retry-accounting',
			at: { method: 'put', line: 2 },
			text: '        self._attempts[task] = 0',
			neighbour: { method: 'put', line: 1, text: '        self._queue.insert(len(self._queue), (ready_at, task))' },
			symptom: { method: 'fail', line: 2, text: '        if attempts + 1 >= self.max_attempts:' },
			report: {
				steps: [
					'q = RetryQueue(max_attempts=3, backoff=10)',
					'q.put("a")',
					'q.take(0); q.fail("a", 0)',
					'q.take(10); q.fail("a", 10)',
					'q.take(30); q.fail("a", 30)',
					'q.dead_letters()'
				],
				expected: '`["a"]`: три попытки исчерпаны',
				actual: '`[]`, задача снова в очереди'
			}
		},
		{
			kind: 'retry-accounting',
			at: { method: 'fail', line: 2 },
			text: '        if attempts > self.max_attempts:',
			neighbour: { method: 'fail', line: 1, text: '        attempts = self._attempts.get(task, 0)' },
			symptom: null,
			// max_attempts is read by this comparison only: storing one less restores the contract too.
			alternatives: [{ method: '__init__', line: 1, text: '        self.max_attempts = max_attempts - 1' }],
			report: {
				steps: [
					'q = RetryQueue(max_attempts=3, backoff=10)',
					'q.put("a")',
					'q.take(0); q.fail("a", 0)',
					'q.take(10); q.fail("a", 10)',
					'q.take(30); q.fail("a", 30)',
					'q.dead_letters()'
				],
				expected: '`["a"]`: три попытки исчерпаны',
				actual: '`[]`, задача вернётся в очередь в момент 70'
			}
		},
		{
			kind: 'retry-accounting',
			at: { method: 'fail', line: 5 },
			text: '        self.put(task, now + self.backoff * 2 ** attempts)',
			neighbour: { method: 'fail', line: 1, text: '        attempts = self._attempts.get(task, 0)' },
			symptom: null,
			report: {
				steps: ['q = RetryQueue(max_attempts=3, backoff=10)', 'q.put("a")', 'q.take(0); q.fail("a", 0)', 'q.take(10)'],
				expected: '`"a"`: после первой попытки пауза 10 секунд',
				actual: '`None`'
			}
		}
	]
};

const WALLET: Program = {
	head: [
		'class Wallet:',
		'    """Бонусный кошелёк.',
		'    - credit(op_id, amount) и debit(op_id, amount) идемпотентны по op_id: повтор операции с тем же op_id',
		'      ничего не меняет и возвращает результат первого вызова. op_id у credit и debit общие: операция',
		'      с op_id, который уже встречался в любом из них, — повтор.',
		'    - debit больше баланса отклоняется (False); отказ тоже запоминается: повтор с тем же op_id снова',
		'      возвращает False, даже если баланс за это время вырос.',
		'    - history() — копия списка применённых операций (op_id, сумма со знаком)."""'
	],
	methods: [
		{
			name: '__init__',
			lines: [
				'    def __init__(self):',
				'        self.balance = 0',
				'        self._done = {}',
				'        self._history = []'
			]
		},
		{
			name: 'credit',
			lines: [
				'    def credit(self, op_id, amount):',
				'        if op_id in self._done:',
				'            return self._done[op_id]',
				'        self.balance += amount',
				'        self._history.append((op_id, amount))',
				'        self._done[op_id] = True',
				'        return True'
			]
		},
		{
			name: 'debit',
			lines: [
				'    def debit(self, op_id, amount):',
				'        if op_id in self._done:',
				'            return self._done[op_id]',
				'        ok = amount <= self.balance',
				'        if ok:',
				'            self.balance -= amount',
				'            self._history.append((op_id, -amount))',
				'        self._done[op_id] = ok',
				'        return ok'
			]
		},
		{ name: 'history', lines: ['    def history(self):', '        return list(self._history)'] }
	],
	checks: [
		'w = Wallet()',
		'assert w.credit("c1", 100)',
		'assert w.credit("c1", 100)',
		'assert w.balance == 100',
		'assert not w.debit("d1", 150)',
		'assert w.credit("c2", 100)',
		'assert not w.debit("d1", 150)',
		'assert w.balance == 200',
		'assert w.debit("d2", 150)',
		'assert w.debit("d2", 150)',
		'assert w.balance == 50',
		'assert w.history() == [("c1", 100), ("c2", 100), ("d2", -150)]',
		'view = w.history()',
		'view.append(("x", 1))',
		'assert len(w.history()) == 3'
	],
	defects: [
		{
			kind: 'double-apply',
			at: { method: 'debit', line: 7 },
			text: '        if ok: self._done[op_id] = ok',
			neighbour: { method: 'debit', line: 3, text: '        ok = self.balance >= amount' },
			symptom: {
				method: 'debit',
				line: 1,
				text: '        if op_id in self._done or op_id in [o for o, _ in self._history]:'
			},
			report: {
				steps: [
					'w = Wallet()',
					'w.credit("c1", 100)',
					'w.debit("d1", 150)   # False',
					'w.credit("c2", 100)',
					'w.debit("d1", 150)   # повтор той же операции',
					'w.balance'
				],
				expected: 'повтор `debit` возвращает `False`, баланс `200`',
				actual: 'повтор возвращает `True`, баланс `50`'
			}
		},
		{
			kind: 'double-apply',
			at: { method: 'credit', line: 1 },
			text: '        if op_id in self._history:',
			neighbour: { method: 'credit', line: 5, text: '        self._done[op_id] = bool(amount) or True' },
			symptom: {
				method: 'credit',
				line: 4,
				text: '        if (op_id, amount) not in self._history: self._history.append((op_id, amount))'
			},
			report: {
				steps: ['w = Wallet()', 'w.credit("c1", 100)', 'w.credit("c1", 100)   # повтор', 'w.balance'],
				expected: '`100`',
				actual: '`200`'
			}
		},
		{
			kind: 'double-apply',
			at: { method: 'debit', line: 1 },
			text: '        if self._done.get(op_id):',
			neighbour: { method: 'debit', line: 3, text: '        ok = self.balance >= amount' },
			symptom: { method: 'debit', line: 7, text: '        self._done[op_id] = bool(ok)' },
			report: {
				steps: [
					'w = Wallet()',
					'w.credit("c1", 100)',
					'w.debit("d1", 150)   # False',
					'w.credit("c2", 100)',
					'w.debit("d1", 150)   # повтор той же операции',
					'w.balance'
				],
				expected: 'повтор `debit` возвращает `False`, баланс `200`',
				actual: 'повтор возвращает `True`, баланс `50`'
			}
		}
	]
};

const CATALOG: Program = {
	head: [
		'class Catalog:',
		'    """Каталог с кэшем стоимости строк корзины; суммы — целые рубли.',
		'    - set_price(sku, price) задаёт цену товара; set_discount(percent) — скидку на итог.',
		'    - line(sku, qty) — стоимость строки price * qty; результат кэшируется, но после set_price товара',
		'      line должна давать новую стоимость.',
		'    - quote(cart) — итог по корзине {sku: qty}: сумма line по строкам минус скидка — discount процентов',
		'      от этой суммы, у скидки дробная часть рубля отбрасывается."""'
	],
	methods: [
		{
			name: '__init__',
			lines: [
				'    def __init__(self):',
				'        self._prices = {}',
				'        self.discount = 0',
				'        self._lines = {}'
			]
		},
		{
			name: 'set_price',
			lines: [
				'    def set_price(self, sku, price):',
				'        self._prices[sku] = price',
				'        for key in [k for k in self._lines if k[0] == sku]:',
				'            del self._lines[key]'
			]
		},
		{ name: 'set_discount', lines: ['    def set_discount(self, percent):', '        self.discount = percent'] },
		{
			name: 'line',
			lines: [
				'    def line(self, sku, qty):',
				'        key = (sku, qty)',
				'        if key not in self._lines:',
				'            self._lines[key] = self._prices[sku] * qty',
				'        return self._lines[key]'
			]
		},
		{
			name: 'quote',
			lines: [
				'    def quote(self, cart):',
				'        subtotal = sum(self.line(sku, qty) for sku, qty in cart.items())',
				'        return subtotal - subtotal * self.discount // 100'
			]
		}
	],
	checks: [
		'cat = Catalog()',
		'cat.set_price("tea", 100)',
		'cat.set_price("cup", 250)',
		'assert cat.quote({"tea": 2, "cup": 1}) == 450',
		'assert cat.line("tea", 3) == 300',
		'cat.set_price("tea", 120)',
		'assert cat.line("tea", 2) == 240',
		'assert cat.line("tea", 3) == 360',
		'assert cat.quote({"tea": 2, "cup": 1}) == 490',
		'cat.set_discount(10)',
		'assert cat.quote({"tea": 2, "cup": 1}) == 441',
		'assert cat.quote({"tea": 1}) == 108',
		'cat.set_price("jam", 101)',
		'assert cat.quote({"jam": 1}) == 91'
	],
	defects: [
		{
			kind: 'cache-invalidation',
			at: { method: 'set_price', line: 2 },
			text: '        for key in [k for k in self._lines if k == sku]:',
			neighbour: { method: 'set_price', line: 1, text: '        self._prices.update({sku: price})' },
			// The price in the key of the cache keeps a line up to date as well: the stale entries are never read.
			alternatives: [{ method: 'line', line: 1, text: '        key = (sku, qty, self._prices[sku])' }],
			symptom: {
				method: 'quote',
				line: 1,
				text: '        subtotal = sum(self._prices[sku] * qty for sku, qty in cart.items())'
			},
			report: {
				steps: [
					'cat = Catalog()',
					'cat.set_price("tea", 100)',
					'cat.quote({"tea": 2})   # 200',
					'cat.set_price("tea", 120)',
					'cat.quote({"tea": 2})'
				],
				expected: '`240`',
				actual: '`200`'
			}
		},
		{
			kind: 'cache-invalidation',
			at: { method: 'line', line: 1 },
			text: '        key = sku',
			neighbour: { method: 'line', line: 2, text: '        if self._lines.get(key) is None:' },
			symptom: {
				method: 'quote',
				line: 1,
				text: '        subtotal = sum(self._prices[sku] * qty for sku, qty in cart.items())'
			},
			report: {
				steps: [
					'cat = Catalog()',
					'cat.set_price("tea", 100)',
					'cat.quote({"tea": 1})   # 100',
					'cat.quote({"tea": 3})'
				],
				expected: '`300`',
				actual: '`100`'
			}
		}
	]
};

const BUS: Program = {
	head: [
		'class EventBus:',
		'    """Подписки на события.',
		'    - subscribe(event, handler, once=False) добавляет обработчик; once=True — обработчик вызывается',
		'      один раз и отписывается. Один и тот же обработчик на одно событие подписывают не больше одного раза.',
		'    - publish(event, payload) вызывает обработчики события в порядке подписки: каждого, кто был подписан',
		'      в момент публикации, ровно один раз, даже если обработчики во время вызова отписываются или',
		'      подписывают новых (новые получают события со следующей публикации). Возвращает число вызовов.',
		'      Обработчики не вызывают publish (вложенных публикаций нет)."""'
	],
	methods: [
		{ name: '__init__', lines: ['    def __init__(self):', '        self._subs = {}'] },
		{
			name: 'subscribe',
			lines: [
				'    def subscribe(self, event, handler, once=False):',
				'        self._subs.setdefault(event, []).append((handler, once))'
			]
		},
		{
			name: 'unsubscribe',
			lines: [
				'    def unsubscribe(self, event, handler):',
				'        subs = self._subs.get(event, [])',
				'        for i, (h, _) in enumerate(subs):',
				'            if h is handler:',
				'                del subs[i]',
				'                return'
			]
		},
		{
			name: 'publish',
			lines: [
				'    def publish(self, event, payload):',
				'        called = 0',
				'        for handler, once in list(self._subs.get(event, [])):',
				'            handler(payload)',
				'            called += 1',
				'            if once:',
				'                self.unsubscribe(event, handler)',
				'        return called'
			]
		}
	],
	checks: [
		'log = []',
		'bus = EventBus()',
		'def a(p):',
		'    log.append(("a", p))',
		'def b(p):',
		'    log.append(("b", p))',
		'bus.subscribe("x", a, once=True)',
		'bus.subscribe("x", b, once=True)',
		'assert bus.publish("x", 1) == 2',
		'assert bus.publish("x", 2) == 0',
		'def c(p):',
		'    log.append(("c", p))',
		'    bus.subscribe("x", b)',
		'bus.subscribe("x", c, once=True)',
		'assert bus.publish("x", 3) == 1',
		'assert bus.publish("x", 4) == 1',
		'assert log == [("a", 1), ("b", 1), ("c", 3), ("b", 4)]'
	],
	defects: [
		{
			kind: 'iteration',
			at: { method: 'publish', line: 2 },
			text: '        for handler, once in self._subs.get(event, []):',
			neighbour: { method: 'publish', line: 3, text: '            handler(payload) if handler else None' },
			symptom: null,
			report: {
				steps: [
					'bus = EventBus()',
					'bus.subscribe("x", a, once=True)   # a и b записывают вызов в журнал',
					'bus.subscribe("x", b, once=True)',
					'bus.publish("x", 1)'
				],
				expected: '`2`: вызваны a и b',
				actual: '`1`: b не вызван'
			}
		}
	]
};

const INVENTORY: Program = {
	head: [
		'class Inventory:',
		'    """Остатки и резервы.',
		'    - reserve(rid, sku, qty, until) резервирует qty штук до момента until, если хватает свободного',
		'      остатка; иначе False. Резерв с уже существующим rid не создаётся (False).',
		'    - release(rid) снимает резерв и возвращает товар в остаток; повторный release того же rid —',
		'      False, ничего не меняется.',
		'    - release_expired(now) снимает все резервы с until <= now и возвращает их число.',
		'    - available(sku) — свободный остаток.',
		'    Резервируются только товары из stock, переданного при создании, и qty больше 0."""'
	],
	methods: [
		{
			name: '__init__',
			lines: ['    def __init__(self, stock):', '        self._stock = dict(stock)', '        self._reservations = {}']
		},
		{ name: 'available', lines: ['    def available(self, sku):', '        return self._stock.get(sku, 0)'] },
		{
			name: 'reserve',
			lines: [
				'    def reserve(self, rid, sku, qty, until):',
				'        if rid in self._reservations or self.available(sku) < qty:',
				'            return False',
				'        self._stock[sku] -= qty',
				'        self._reservations[rid] = (sku, qty, until)',
				'        return True'
			]
		},
		{
			name: 'release',
			lines: [
				'    def release(self, rid):',
				'        if rid not in self._reservations:',
				'            return False',
				'        sku, qty, _ = self._reservations.pop(rid)',
				'        self._stock[sku] += qty',
				'        return True'
			]
		},
		{
			name: 'release_expired',
			lines: [
				'    def release_expired(self, now):',
				'        released = 0',
				'        for rid in list(self._reservations):',
				'            sku, qty, until = self._reservations[rid]',
				'            if until <= now:',
				'                del self._reservations[rid]',
				'                self._stock[sku] += qty',
				'                released += 1',
				'        return released'
			]
		}
	],
	checks: [
		'inv = Inventory({"a": 10, "b": 5})',
		'assert inv.reserve("r1", "a", 3, 100)',
		'assert not inv.reserve("r1", "a", 1, 100)',
		'assert inv.available("a") == 7',
		'assert inv.release("r1")',
		'assert not inv.release("r1")',
		'assert inv.available("a") == 10',
		'assert inv.reserve("r2", "a", 4, 50)',
		'assert inv.reserve("r3", "b", 5, 60)',
		'assert inv.reserve("r4", "a", 2, 200)',
		'assert not inv.reserve("r5", "b", 1, 60)',
		'assert inv.release_expired(60) == 2',
		'assert inv.available("a") == 8 and inv.available("b") == 5',
		'assert not inv.release("r2")',
		'assert inv.release("r4")',
		'assert inv.available("a") == 10'
	],
	defects: [
		{
			kind: 'double-apply',
			at: { method: 'release', line: 3 },
			text: '        sku, qty, _ = self._reservations[rid]',
			neighbour: { method: 'release', line: 4, text: '        self._stock[sku] = self._stock[sku] + qty' },
			symptom: null,
			report: {
				steps: [
					'inv = Inventory({"a": 10})',
					'inv.reserve("r1", "a", 3, 100)',
					'inv.release("r1")',
					'inv.release("r1")',
					'inv.available("a")'
				],
				expected: 'второй `release` возвращает `False`, остаток `10`',
				actual: 'второй `release` возвращает `True`, остаток `13`'
			}
		},
		{
			kind: 'double-apply',
			at: { method: 'reserve', line: 1 },
			text: '        if self.available(sku) < qty:',
			neighbour: { method: 'reserve', line: 3, text: '        self._stock[sku] = self._stock[sku] - qty' },
			symptom: { method: 'reserve', line: 4, text: '        self._reservations.setdefault(rid, (sku, qty, until))' },
			report: {
				steps: [
					'inv = Inventory({"a": 10})',
					'inv.reserve("r1", "a", 3, 100)',
					'inv.reserve("r1", "a", 3, 100)   # повтор того же запроса',
					'inv.available("a")'
				],
				expected: 'повтор возвращает `False`, остаток `7`',
				actual: 'повтор возвращает `True`, остаток `4`'
			}
		},
		{
			kind: 'iteration',
			at: { method: 'release_expired', line: 2 },
			text: '        for rid in self._reservations:',
			neighbour: {
				method: 'release_expired',
				line: 3,
				text: '            sku, qty, until = self._reservations.get(rid)'
			},
			symptom: { method: 'release_expired', line: 5, text: '                self._reservations.pop(rid, None)' },
			report: {
				steps: [
					'inv = Inventory({"a": 10, "b": 5})',
					'inv.reserve("r2", "a", 4, 50)',
					'inv.reserve("r3", "b", 5, 60)',
					'inv.release_expired(60)'
				],
				expected: '`2`',
				actual: '`RuntimeError: dictionary changed size during iteration`'
			}
		}
	]
};

const LIBRARY: Record<string, Program[]> = {
	middle: [CART, SESSION, LIMITER, ORDER],
	senior: [RETRY_QUEUE, WALLET, CATALOG, BUS, INVENTORY]
};

/** Module-level helpers a module of this kind often has: surface that moves the class down. */
const HELPERS: readonly string[][] = [
	['def money(value):', '    return f"{value} ₽"'],
	['def clamp(value, low, high):', '    return max(low, min(value, high))'],
	['def normalize_sku(sku):', '    return sku.strip().lower()'],
	['def is_positive(value):', '    return value > 0'],
	['def percent(part, whole):', '    if whole == 0:', '        return 0', '    return part * 100 // whole'],
	['def chunks(items, size):', '    return [items[i:i + size] for i in range(0, len(items), size)]'],
	['def first(items, default=None):', '    for item in items:', '        return item', '    return default']
];

const MODULE_TITLES = ['Доменные объекты сервиса', 'Состояние сессии и заказа', 'Модели магазина', 'Ядро сервиса'];
const HEADER = [
	'import logging',
	'from dataclasses import dataclass',
	'LOG_LEVEL = "INFO"',
	'DEFAULT_CURRENCY = "RUB"',
	'SCHEMA_VERSION = 3',
	'FEATURE_FLAGS = {"new_checkout": False}'
];

interface Composed {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	symptom: { line: number; text: string } | null;
	alternatives: { line: number; fix: string }[];
	report: Defect['report'];
	className: string;
}

function compose(rng: Rng, library: readonly Program[], kind: string): Composed {
	const candidates = library.flatMap((p) => p.defects.filter((d) => d.kind === kind).map((d) => ({ p, d })));
	const { p, d } = rng.pick(candidates);
	const header = rng.sample(HEADER, rng.int(0, 5));
	// `import` lines first, then the rest, as a module would have them.
	header.sort(
		(a, b) =>
			Number(!a.startsWith('import') && !a.startsWith('from')) -
			Number(!b.startsWith('import') && !b.startsWith('from'))
	);
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		...(header.length ? ['', ...header] : []),
		...rng.sample(HELPERS, rng.int(0, 3)).flatMap((h) => ['', '', ...h]),
		'',
		'',
		...p.head,
		''
	];
	const [init, ...rest] = p.methods;
	const order = [init, ...rng.shuffle(rest)].filter((m) => m !== undefined);
	const start = new Map<string, number>();
	order.forEach((m, i) => {
		if (i > 0) lines.push('');
		start.set(m.name, lines.length);
		lines.push(...m.lines);
	});
	const lineOf = (at: At) => (start.get(at.method) ?? 0) + at.line + 1;
	const answer = lineOf(d.at);
	const fix = lines[answer - 1] ?? '';
	lines[answer - 1] = d.text;
	const check = [
		'def _spec():',
		...p.checks.map((c) => `    ${c}`),
		'',
		'try:',
		'    _spec()',
		"    print('ok')",
		'except Exception as exc:',
		"    print('fail', type(exc).__name__)"
	].join('\n');
	return {
		source: lines.join('\n'),
		check,
		answer,
		fix,
		neighbour: { line: lineOf(d.neighbour), text: d.neighbour.text },
		symptom: d.symptom ? { line: lineOf(d.symptom), text: d.symptom.text } : null,
		alternatives: (d.alternatives ?? []).map((a) => ({ line: lineOf(a), fix: a.text })),
		report: d.report,
		className: (p.head[0] ?? '').replace(/^class (\w+):$/, '$1')
	};
}

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const c = compose(rng, LIBRARY[input.grade] ?? [], cls.id);
	const markdown = [
		`Модуль на Python 3 с классом \`${c.className}\`; его спецификация — в строке документации класса. Тестировщик завёл баг-репорт:`,
		'',
		'Шаги воспроизведения:',
		'',
		'```',
		...c.report.steps,
		'```',
		'',
		`- Ожидаемо: ${c.report.expected}.`,
		`- Фактически: ${c.report.actual}.`,
		'',
		'Найдите строку модуля, которая расходится со спецификацией и даёт баг из репорта: если заменить только её, класс будет работать по спецификации во всех сценариях, не только в этом. Введите номер этой строки (нумерация с 1). Например: `23`.',
		'Если исправить можно в нескольких строках — засчитывается любая из них. Исправление — одна простая инструкция того же вида, что исправляемая строка: не добавляйте конструкций, которых в ней нет (`:=`, lambda, обёртки, новые функции), и не переносите в неё логику из другой строки.'
	].join('\n');
	const instance = makeInstance(descriptor, input, {
		statement: { markdown, code: { language: 'python3', source: c.source } },
		answer: {
			kind: 'line_no',
			value: c.answer,
			...(c.alternatives.length ? { alternatives: c.alternatives.map((a) => a.line) } : {})
		}
	});
	return {
		instance,
		reference: () => ({
			kind: 'bug',
			check: c.check,
			fix: c.fix,
			...(c.alternatives.length ? { alternatives: c.alternatives } : {})
		}),
		wrong: () => ({
			'neighbour-line': { kind: 'line', line: c.neighbour.line, replacement: c.neighbour.text },
			'symptom-line': c.symptom ? { kind: 'line', line: c.symptom.line, replacement: c.symptom.text } : null
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
