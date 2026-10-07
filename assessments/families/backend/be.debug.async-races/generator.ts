// A module of asyncio service classes, each with its contract in the docstring; exactly one line breaks its class's
// contract under concurrent calls. The candidate names that line. Every defect shows deterministically: the checks
// interleave coroutines only through `asyncio.sleep(0)`, events and queues, never real delays. The defect's kind is
// the essential class; the other classes, their order and the module header are surface.
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

/** A defect: the original line it replaces (`at`, unique in its unit), and a plausible but wrong neighbouring change. */
interface Defect {
	kind: string;
	at: string;
	text: string;
	neighbour: { at: string; text: string };
	/** Other lines where a one-instruction replacement also restores the contract. */
	alternatives?: { at: string; text: string }[];
}

/** A class of the module: its lines, the checks of its contract and its possible defects. */
interface Unit {
	lines: string[];
	/** Python statements, each raising when the contract is broken. */
	checks: string[];
	defects: Defect[];
}

const MIDDLE: Unit[] = [
	{
		lines: [
			'class Inventory:',
			'    """Остатки товаров в store (асинхронные get и put). reserve(sku, qty) списывает qty и возвращает',
			'    True, если остатка хватает; иначе False. Остаток не уходит в минус и при одновременных вызовах."""',
			'',
			'    def __init__(self, store):',
			'        self.store = store',
			'        self._lock = asyncio.Lock()',
			'',
			'    async def reserve(self, sku, qty):',
			'        async with self._lock:',
			'            available = await self.store.get(sku)',
			'            if available < qty:',
			'                return False',
			'            await self.store.put(sku, available - qty)',
			'            return True'
		],
		checks: [
			'class InStore:',
			'    def __init__(self, data):',
			'        self.data = dict(data)',
			'    async def get(self, key):',
			'        value = self.data[key]',
			'        await asyncio.sleep(0)',
			'        return value',
			'    async def put(self, key, value):',
			'        await asyncio.sleep(0)',
			'        self.data[key] = value',
			'async def _inventory():',
			'    inv = Inventory(InStore({"a": 5, "b": 1}))',
			'    done = await asyncio.gather(inv.reserve("a", 3), inv.reserve("a", 3), inv.reserve("b", 1))',
			'    return done, inv.store.data',
			'assert asyncio.run(_inventory()) == ([True, False, True], {"a": 2, "b": 0})'
		],
		defects: [
			{
				kind: 'check-then-act',
				at: '        async with self._lock:',
				text: '        async with asyncio.Lock():',
				neighbour: { at: '            if available < qty:', text: '            if available <= qty - 1:' }
			}
		]
	},
	{
		lines: [
			'class Wallet:',
			'    """deposit(amount) зачисляет amount, если асинхронная проверка antifraud(amount, new_balance)',
			'    одобрила пополнение, и возвращает True; отклонённое пополнение — False. new_balance — предварительный',
			'    баланс: снимок баланса в момент вызова плюс amount, только для оценки риска (одновременные',
			'    пополнения могут его обогнать). После любых одновременных пополнений баланс равен сумме зачисленных."""',
			'',
			'    def __init__(self, antifraud):',
			'        self.antifraud = antifraud',
			'        self.balance = 0',
			'',
			'    async def deposit(self, amount):',
			'        new_balance = self.balance + amount',
			'        if not await self.antifraud(amount, new_balance):',
			'            return False',
			'        self.balance += amount',
			'        return True'
		],
		checks: [
			'async def wl_antifraud(amount, new_balance):',
			'    await asyncio.sleep(0)',
			'    return amount <= 100_000',
			'async def _wallet():',
			'    w = Wallet(wl_antifraud)',
			'    done = await asyncio.gather(w.deposit(10), w.deposit(5), w.deposit(200_000), w.deposit(7))',
			'    return done, w.balance',
			'assert asyncio.run(_wallet()) == ([True, True, False, True], 22)'
		],
		defects: [
			{
				kind: 'check-then-act',
				at: '        self.balance += amount',
				text: '        self.balance = new_balance',
				neighbour: { at: '            return False', text: '            return None' }
			}
		]
	},
	{
		lines: [
			'class Booking:',
			'    """book(seat, user): занимает свободное место и возвращает True; занятое — False. Каждая попытка',
			'    сначала пишется в аудит (асинхронный audit(user, seat)), занятое место сохраняется асинхронным',
			'    save(seat, user). Одно место никогда не достаётся двоим, даже при одновременных вызовах."""',
			'',
			'    def __init__(self, seats, audit, save):',
			'        self.taken = {seat: None for seat in seats}',
			'        self.audit = audit',
			'        self.save = save',
			'        self._lock = asyncio.Lock()',
			'',
			'    async def book(self, seat, user):',
			'        free = [s for s, owner in self.taken.items() if owner is None]',
			'        if seat not in free:',
			'            return False',
			'        await self.audit(user, seat)',
			'        async with self._lock:',
			'            if self.taken[seat] is not None:',
			'                return False',
			'            self.taken[seat] = user',
			'            await self.save(seat, user)',
			'        return True'
		],
		checks: [
			'bk_log, bk_saved = [], []',
			'async def bk_audit(user, seat):',
			'    await asyncio.sleep(0)',
			'    bk_log.append((user, seat))',
			'async def bk_save(seat, user):',
			'    await asyncio.sleep(0)',
			'    bk_saved.append((seat, user))',
			'async def _booking():',
			'    b = Booking(["A1", "A2"], bk_audit, bk_save)',
			'    done = await asyncio.gather(b.book("A1", "ann"), b.book("A1", "bob"), b.book("A2", "eve"))',
			'    return done, b.taken, sorted(bk_log), bk_saved',
			'assert asyncio.run(_booking()) == (',
			'    [True, False, True],',
			'    {"A1": "ann", "A2": "eve"},',
			'    [("ann", "A1"), ("bob", "A1"), ("eve", "A2")],',
			'    [("A1", "ann"), ("A2", "eve")],',
			')'
		],
		defects: [
			{
				kind: 'check-then-act',
				at: '            if self.taken[seat] is not None:',
				text: '            if seat not in free:',
				neighbour: { at: '        if seat not in free:', text: '        if free.count(seat) == 0:' }
			}
		]
	},
	{
		lines: [
			'class Orders:',
			'    """create(order_id) сохраняет заказ, затем пишет в журнал событие \'created:<id>\' и возвращает id;',
			'    к возврату из create и заказ, и событие уже записаны."""',
			'',
			'    def __init__(self):',
			'        self.saved = []',
			'        self.journal = []',
			'',
			'    async def _save(self, order_id):',
			'        await asyncio.sleep(0)',
			'        self.saved.append(order_id)',
			'',
			'    async def _log(self, event):',
			'        await asyncio.sleep(0)',
			'        self.journal.append(event)',
			'',
			'    async def create(self, order_id):',
			'        await self._save(order_id)',
			'        await self._log(f"created:{order_id}")',
			'        return order_id'
		],
		checks: [
			'async def _orders():',
			'    o = Orders()',
			'    first = await o.create(1)',
			'    return first, list(o.saved), list(o.journal)',
			'assert asyncio.run(_orders()) == (1, [1], ["created:1"])'
		],
		defects: [
			{
				kind: 'missing-await',
				at: '        await self._log(f"created:{order_id}")',
				text: '        self._log(f"created:{order_id}")',
				neighbour: { at: '        return order_id', text: '        return int(order_id)' }
			},
			{
				kind: 'missing-await',
				at: '        await self._save(order_id)',
				text: '        self._save(order_id)',
				neighbour: { at: '        self.saved.append(order_id)', text: '        self.saved += [order_id]' }
			}
		]
	},
	{
		lines: [
			'class PriceService:',
			'    """total(skus) — сумма цен товаров; цены запрашиваются одновременно."""',
			'',
			'    def __init__(self, prices):',
			'        self.prices = prices',
			'',
			'    async def price(self, sku):',
			'        await asyncio.sleep(0)',
			'        return self.prices[sku]',
			'',
			'    async def total(self, skus):',
			'        values = await asyncio.gather(*(self.price(s) for s in skus))',
			'        return sum(values)'
		],
		checks: [
			'async def _prices():',
			'    return await PriceService({"a": 120, "b": 75}).total(["a", "b", "a"])',
			'assert asyncio.run(_prices()) == 315'
		],
		defects: [
			{
				kind: 'missing-await',
				at: '        values = await asyncio.gather(*(self.price(s) for s in skus))',
				text: '        values = [self.price(s) for s in skus]',
				neighbour: { at: '        return sum(values)', text: '        return sum(list(values))' }
			}
		]
	},
	{
		lines: [
			'class AccessGuard:',
			'    """allowed(user, action): True, только если пользователь не заблокирован и у его роли',
			'    есть право action."""',
			'',
			'    def __init__(self, blocked, roles, rights):',
			'        self.blocked = blocked',
			'        self.roles = roles',
			'        self.rights = rights',
			'',
			'    async def is_blocked(self, user):',
			'        await asyncio.sleep(0)',
			'        return user in self.blocked',
			'',
			'    async def allowed(self, user, action):',
			'        if await self.is_blocked(user):',
			'            return False',
			'        role = self.roles.get(user)',
			'        return action in self.rights.get(role, ())'
		],
		checks: [
			'async def _guard():',
			'    g = AccessGuard({"mallory"}, {"ann": "admin", "mallory": "admin"}, {"admin": ("read", "write")})',
			'    return await asyncio.gather(g.allowed("ann", "write"), g.allowed("mallory", "read"), g.allowed("bob", "read"))',
			'assert asyncio.run(_guard()) == [True, False, False]'
		],
		defects: [
			{
				kind: 'missing-await',
				at: '        if await self.is_blocked(user):',
				text: '        if self.is_blocked(user):',
				neighbour: { at: '        role = self.roles.get(user)', text: '        role = self.roles.get(user, "guest")' }
			}
		]
	},
	{
		lines: [
			'class ConnectionPool:',
			'    """query(sql) берёт соединение из пула, выполняет запрос и всегда возвращает соединение',
			'    в пул — и когда запрос падает с ошибкой тоже; ошибка выходит наружу."""',
			'',
			'    def __init__(self, size):',
			'        self.free = asyncio.Queue()',
			'        for n in range(size):',
			'            self.free.put_nowait(f"conn{n}")',
			'        self.failed = 0',
			'',
			'    async def _execute(self, conn, sql):',
			'        await asyncio.sleep(0)',
			'        if sql.startswith("BAD"):',
			'            raise RuntimeError(sql)',
			'        return f"{conn}:{sql}"',
			'',
			'    async def query(self, sql):',
			'        conn = await self.free.get()',
			'        try:',
			'            result = await self._execute(conn, sql)',
			'        except RuntimeError:',
			'            self.failed += 1',
			'            raise',
			'        finally:',
			'            self.free.put_nowait(conn)',
			'        return result'
		],
		checks: [
			'async def _pool():',
			'    pool = ConnectionPool(1)',
			'    first = await pool.query("SELECT 1")',
			'    try:',
			'        await pool.query("BAD 2")',
			'        raise AssertionError("no error")',
			'    except RuntimeError:',
			'        pass',
			'    return first, pool.failed, pool.free.qsize()',
			'assert asyncio.run(_pool()) == ("conn0:SELECT 1", 1, 1)'
		],
		defects: [
			{
				kind: 'lock-release',
				at: '        finally:',
				text: '        else:',
				neighbour: { at: '            self.failed += 1', text: '            self.failed = self.failed + 1' }
			}
		]
	},
	{
		lines: [
			'class Exporter:',
			'    """export(rows) пишет строки под блокировкой; если запись падает, ошибка выходит наружу,',
			'    а блокировка освобождается."""',
			'',
			'    def __init__(self):',
			'        self._lock = asyncio.Lock()',
			'        self.written = []',
			'        self.errors = 0',
			'',
			'    async def _write(self, row):',
			'        await asyncio.sleep(0)',
			'        if row is None:',
			'            raise ValueError("empty row")',
			'        self.written.append(row)',
			'',
			'    async def export(self, rows):',
			'        await self._lock.acquire()',
			'        try:',
			'            for row in rows:',
			'                await self._write(row)',
			'        except ValueError:',
			'            self.errors += 1',
			'            raise',
			'        finally:',
			'            self._lock.release()'
		],
		checks: [
			'async def _export():',
			'    e = Exporter()',
			'    await e.export(["a"])',
			'    try:',
			'        await e.export(["b", None])',
			'        raise AssertionError("no error")',
			'    except ValueError:',
			'        pass',
			'    return e.written, e.errors, e._lock.locked()',
			'assert asyncio.run(_export()) == (["a", "b"], 1, False)'
		],
		defects: [
			{
				kind: 'lock-release',
				at: '        finally:',
				text: '        else:',
				neighbour: { at: '            self.errors += 1', text: '            self.errors = len(self.written)' }
			}
		]
	},
	{
		lines: [
			'class Throttle:',
			'    """run(job) выполняет job, когда одновременно выполняется меньше limit задач, и возвращает',
			'    её результат; место освобождается только после завершения job, в том числе с ошибкой."""',
			'',
			'    def __init__(self, limit):',
			'        self._slots = asyncio.Semaphore(limit)',
			'        self.running = 0',
			'',
			'    async def run(self, job):',
			'        async with self._slots:',
			'            self.running += 1',
			'            try:',
			'                return await job()',
			'            finally:',
			'                self.running -= 1'
		],
		checks: [
			'async def _throttle():',
			'    t = Throttle(1)',
			'    active = [0, 0]',
			'    async def job():',
			'        active[0] += 1',
			'        active[1] = max(active[1], active[0])',
			'        await asyncio.sleep(0)',
			'        active[0] -= 1',
			'        return "done"',
			'    async def broken():',
			'        raise RuntimeError("boom")',
			'    results = await asyncio.gather(t.run(job), t.run(job), t.run(broken), t.run(job), return_exceptions=True)',
			'    return active[1], [r if isinstance(r, str) else type(r).__name__ for r in results], t.running',
			'assert asyncio.run(_throttle()) == (1, ["done", "done", "RuntimeError", "done"], 0)'
		],
		defects: [
			{
				kind: 'lock-release',
				at: '                return await job()',
				text: '                return asyncio.ensure_future(job())',
				neighbour: { at: '            self.running += 1', text: '            self.running = self.running + 1' }
			}
		]
	}
];

const SENIOR: Unit[] = [
	{
		lines: [
			'class ProfileCache:',
			'    """get(user_id) возвращает профиль — плоский словарь, значения полей неизменяемые (строки, числа).',
			'    Одновременные промахи по одному ключу дают одну загрузку: остальные ждут ту же задачу. Каждый вызов',
			'    получает свою копию словаря — правки вызывающего не меняют кэш."""',
			'',
			'    def __init__(self, loader):',
			'        self.loader = loader',
			'        self.cache = {}',
			'        self.inflight = {}',
			'',
			'    async def get(self, user_id):',
			'        if user_id in self.cache:',
			'            return dict(self.cache[user_id])',
			'        task = self.inflight.get(user_id)',
			'        if task is None:',
			'            task = asyncio.ensure_future(self.loader(user_id))',
			'            self.inflight[user_id] = task',
			'        profile = await task',
			'        self.cache[user_id] = profile',
			'        self.inflight.pop(user_id, None)',
			'        return dict(profile)'
		],
		checks: [
			'async def _profiles():',
			'    loads = []',
			'    async def loader(uid):',
			'        loads.append(uid)',
			'        await asyncio.sleep(0)',
			'        return {"id": uid, "name": "ann"}',
			'    c = ProfileCache(loader)',
			'    a, b = await asyncio.gather(c.get(1), c.get(1))',
			'    a["name"] = "x"',
			'    b["name"] = "y"',
			'    c2 = await c.get(1)',
			'    c2["name"] = "z"',
			'    return loads, (await c.get(1))["name"]',
			'assert asyncio.run(_profiles()) == ([1], "ann")'
		],
		defects: [
			{
				kind: 'shared-cache',
				at: '            return dict(self.cache[user_id])',
				text: '            return self.cache[user_id]',
				neighbour: { at: '        if user_id in self.cache:', text: '        if self.cache.get(user_id):' }
			},
			{
				kind: 'shared-cache',
				at: '        return dict(profile)',
				text: '        return profile',
				neighbour: {
					at: '        self.cache[user_id] = profile',
					text: '        self.cache.setdefault(user_id, profile)'
				}
			}
		]
	},
	{
		lines: [
			'class PriceCache:',
			'    """get(sku) читает цену из кэша или из хранилища; update(sku, price) пишет в хранилище и',
			'    сбрасывает кэш. Любой get, начатый после завершения update, возвращает новую цену. get, чьё',
			'    чтение из хранилища началось до update, может вернуть старую цену, но не оставляет её в кэше.',
			'    Повторный get без промежуточного update берёт цену из кэша, не читая хранилище."""',
			'',
			'    def __init__(self, store):',
			'        self.store = store',
			'        self.cache = {}',
			'        self.version = {}',
			'',
			'    async def get(self, sku):',
			'        if sku in self.cache:',
			'            return self.cache[sku]',
			'        seen = self.version.get(sku, 0)',
			'        price = await self.store.read(sku)',
			'        if self.version.get(sku, 0) == seen:',
			'            self.cache[sku] = price',
			'        return price',
			'',
			'    async def update(self, sku, price):',
			'        await self.store.write(sku, price)',
			'        self.version[sku] = self.version.get(sku, 0) + 1',
			'        self.cache.pop(sku, None)'
		],
		checks: [
			'class _PriceStore:',
			'    def __init__(self):',
			'        self.data, self.reads = {"a": 100}, 0',
			'    async def read(self, sku):',
			'        self.reads += 1',
			'        value = self.data[sku]',
			'        await asyncio.sleep(0)',
			'        await asyncio.sleep(0)',
			'        return value',
			'    async def write(self, sku, price):',
			'        await asyncio.sleep(0)',
			'        self.data[sku] = price',
			'async def _price_cache():',
			'    c = PriceCache(_PriceStore())',
			'    first, _ = await asyncio.gather(c.get("a"), c.update("a", 120))',
			'    second, third, reads = await c.get("a"), await c.get("a"), c.store.reads',
			'    await c.update("a", 130)',
			'    racing, _ = await asyncio.gather(c.get("a"), c.update("a", 150))',
			'    return first, second, third, reads, racing, await c.get("a")',
			'assert asyncio.run(_price_cache()) == (100, 120, 120, 2, 130, 150)'
		],
		defects: [
			{
				kind: 'shared-cache',
				at: '        if self.version.get(sku, 0) == seen:',
				text: '        if sku not in self.cache:',
				neighbour: { at: '        seen = self.version.get(sku, 0)', text: '        seen = self.version.get(sku)' }
			},
			{
				kind: 'shared-cache',
				at: '        self.version[sku] = self.version.get(sku, 0) + 1',
				text: '        self.version[sku] = self.version.get(sku, 0)',
				neighbour: { at: '        self.cache.pop(sku, None)', text: '        self.cache.pop(sku, price)' }
			}
		]
	},
	{
		lines: [
			'class Templates:',
			'    """render(name, **values) подставляет значения вместо частей \'$имя\' шаблона; шаблон — список',
			'    частей, загружается при первом обращении и кэшируется. Подстановка не меняет кэш."""',
			'',
			'    def __init__(self, loader):',
			'        self.loader = loader',
			'        self.cache = {}',
			'',
			'    async def _template(self, name):',
			'        if name not in self.cache:',
			'            self.cache[name] = await self.loader(name)',
			'        return self.cache[name]',
			'',
			'    async def render(self, name, **values):',
			'        parts = list(await self._template(name))',
			'        for i, part in enumerate(parts):',
			'            if part.startswith("$"):',
			'                parts[i] = str(values[part[1:]])',
			'        return "".join(parts)'
		],
		checks: [
			'async def _templates():',
			'    async def loader(name):',
			'        await asyncio.sleep(0)',
			'        return ["Привет, ", "$user", "! Заказ ", "$order"]',
			'    t = Templates(loader)',
			'    first = await t.render("greet", user="ann", order=7)',
			'    second = await t.render("greet", user="bob", order=8)',
			'    return first, second',
			'assert asyncio.run(_templates()) == ("Привет, ann! Заказ 7", "Привет, bob! Заказ 8")'
		],
		defects: [
			{
				kind: 'shared-cache',
				at: '        parts = list(await self._template(name))',
				text: '        parts = await self._template(name)',
				neighbour: { at: '            if part.startswith("$"):', text: '            if part[:1] == "$":' }
			}
		]
	},
	{
		lines: [
			'class Accounts:',
			'    """withdraw(account, amount): списывает amount и возвращает True, если на счёте хватает средств;',
			'    иначе False. Номер счёта нормализуется (пробелы, регистр). Балансы хранятся в store (асинхронные',
			'    get и put); операции по одному счёту выполняются по очереди."""',
			'',
			'    def __init__(self, store):',
			'        self.store = store',
			'        self._locks = {}',
			'',
			'    async def withdraw(self, account, amount):',
			'        key = account.strip().upper()',
			'        async with self._locks.setdefault(key, asyncio.Lock()):',
			'            balance = await self.store.get(key)',
			'            if balance < amount:',
			'                return False',
			'            await self.store.put(key, balance - amount)',
			'            return True'
		],
		checks: [
			'class AcStore:',
			'    def __init__(self, data):',
			'        self.data = dict(data)',
			'    async def get(self, key):',
			'        value = self.data[key]',
			'        await asyncio.sleep(0)',
			'        return value',
			'    async def put(self, key, value):',
			'        await asyncio.sleep(0)',
			'        self.data[key] = value',
			'async def _accounts():',
			'    acc = Accounts(AcStore({"ACC1": 100, "ACC2": 50}))',
			'    done = await asyncio.gather(acc.withdraw("acc1", 70), acc.withdraw(" ACC1", 70), acc.withdraw("acc2", 50))',
			'    return done, acc.store.data',
			'assert asyncio.run(_accounts()) == ([True, False, True], {"ACC1": 30, "ACC2": 0})'
		],
		defects: [
			{
				kind: 'lock-scope',
				at: '        async with self._locks.setdefault(key, asyncio.Lock()):',
				text: '        async with self._locks.get(key, asyncio.Lock()):',
				neighbour: { at: '            if balance < amount:', text: '            if balance - amount < 0:' }
			}
		]
	},
	{
		lines: [
			'class Rooms:',
			'    """reserve(room, slot, user): бронирует слот переговорной и возвращает True, если он свободен;',
			'    иначе False. Брони хранятся в store (асинхронные get и put, нет брони — None). Один слот одной',
			'    комнаты не достаётся двоим."""',
			'',
			'    def __init__(self, store):',
			'        self.store = store',
			'        self._locks = {}',
			'',
			'    async def reserve(self, room, slot, user):',
			'        async with self._locks.setdefault((room, slot), asyncio.Lock()):',
			'            if await self.store.get((room, slot)) is not None:',
			'                return False',
			'            await self.store.put((room, slot), user)',
			'            return True'
		],
		checks: [
			'class RmStore:',
			'    def __init__(self):',
			'        self.data = {}',
			'    async def get(self, key):',
			'        value = self.data.get(key)',
			'        await asyncio.sleep(0)',
			'        return value',
			'    async def put(self, key, value):',
			'        await asyncio.sleep(0)',
			'        self.data[key] = value',
			'async def _rooms():',
			'    r = Rooms(RmStore())',
			'    done = await asyncio.gather(r.reserve("A", 10, "ann"), r.reserve("A", 10, "bob"), r.reserve("A", 11, "bob"))',
			'    return done, r.store.data',
			'assert asyncio.run(_rooms()) == ([True, False, True], {("A", 10): "ann", ("A", 11): "bob"})'
		],
		defects: [
			{
				kind: 'lock-scope',
				at: '        async with self._locks.setdefault((room, slot), asyncio.Lock()):',
				text: '        async with self._locks.setdefault((room, user), asyncio.Lock()):',
				neighbour: {
					at: '            await self.store.put((room, slot), user)',
					text: '            await self.store.put((room, slot), str(user))'
				}
			}
		]
	},
	{
		lines: [
			'class Quotas:',
			'    """consume(user, n): списывает n единиц квоты пользователя и возвращает True, если её хватает;',
			'    иначе False. Остатки хранятся в store (асинхронные get и put); списания одного пользователя',
			'    выполняются по очереди, разных пользователей — независимо."""',
			'',
			'    def __init__(self, store, users):',
			'        self.store = store',
			'        self._locks = {user: asyncio.Lock() for user in users}',
			'',
			'    async def consume(self, user, n):',
			'        async with self._locks[user]:',
			'            left = await self.store.get(user)',
			'            if left < n:',
			'                return False',
			'            await self.store.put(user, left - n)',
			'            return True'
		],
		checks: [
			'class QtStore:',
			'    def __init__(self, data):',
			'        self.data = dict(data)',
			'    async def get(self, key):',
			'        value = self.data[key]',
			'        await asyncio.sleep(0)',
			'        return value',
			'    async def put(self, key, value):',
			'        await asyncio.sleep(0)',
			'        self.data[key] = value',
			'async def _quotas():',
			'    q = Quotas(QtStore({"ann": 5, "bob": 3}), ["ann", "bob"])',
			'    done = await asyncio.gather(q.consume("ann", 3), q.consume("ann", 3), q.consume("bob", 3))',
			'    return done, q.store.data',
			'assert asyncio.run(_quotas()) == ([True, False, True], {"ann": 2, "bob": 0})'
		],
		defects: [
			{
				kind: 'lock-scope',
				at: '        async with self._locks[user]:',
				text: '        async with asyncio.Lock():',
				neighbour: { at: '            if left < n:', text: '            if left - n < 0:' }
			}
		]
	},
	{
		lines: [
			'class Job:',
			'    """run() вычисляет результат (compute() никогда не возвращает None), сохраняет его асинхронным',
			'    persist(value) и запоминает; wait() ждёт завершения run() и возвращает сохранённый результат —',
			'    никогда не None."""',
			'',
			'    def __init__(self, compute, persist):',
			'        self.compute = compute',
			'        self.persist = persist',
			'        self.result = None',
			'        self.done = asyncio.Event()',
			'',
			'    async def _store(self, value):',
			'        await self.persist(value)',
			'        self.result = value',
			'',
			'    async def run(self):',
			'        value = await self.compute()',
			'        await self._store(value)',
			'        self.done.set()',
			'',
			'    async def wait(self):',
			'        await self.done.wait()',
			'        return self.result'
		],
		checks: [
			'jb_saved = []',
			'async def jb_compute():',
			'    await asyncio.sleep(0)',
			'    return 42',
			'async def jb_persist(value):',
			'    await asyncio.sleep(0)',
			'    jb_saved.append(value)',
			'async def _job():',
			'    j = Job(jb_compute, jb_persist)',
			'    got, _ = await asyncio.gather(j.wait(), j.run())',
			'    return got, jb_saved',
			'assert asyncio.run(_job()) == (42, [42])'
		],
		defects: [
			{
				kind: 'publish-order',
				at: '        await self._store(value)',
				text: '        asyncio.ensure_future(self._store(value))',
				neighbour: { at: '        value = await self.compute()', text: '        value = (await self.compute())' }
			}
		]
	},
	{
		lines: [
			'class Config:',
			'    """reload(source) загружает все ключи заново и делает новые настройки видимыми разом:',
			'    читатель self.current никогда не видит смесь старых и новых значений."""',
			'',
			'    def __init__(self, initial):',
			'        self.current = dict(initial)',
			'',
			'    async def _fetch(self, source, key):',
			'        await asyncio.sleep(0)',
			'        return source[key]',
			'',
			'    async def reload(self, source):',
			'        fresh = {}',
			'        for key in source:',
			'            fresh[key] = await self._fetch(source, key)',
			'        self.current = fresh'
		],
		checks: [
			'async def _config():',
			'    cfg = Config({"a": 1, "b": 1})',
			'    async def reader():',
			'        await asyncio.sleep(0)',
			'        await asyncio.sleep(0)',
			'        return dict(cfg.current)',
			'    seen, _ = await asyncio.gather(reader(), cfg.reload({"a": 2, "b": 2}))',
			'    return seen, cfg.current',
			'assert asyncio.run(_config()) == ({"a": 1, "b": 1}, {"a": 2, "b": 2})'
		],
		defects: [
			{
				kind: 'publish-order',
				at: '        fresh = {}',
				text: '        fresh = self.current',
				neighbour: { at: '        self.current = fresh', text: '        self.current = dict(fresh)' }
			}
		]
	},
	{
		lines: [
			'class Uploader:',
			'    """upload_all(files) отправляет файлы через асинхронный transport(name) одновременно и возвращается,',
			'    только когда отправлены все; возвращает общее число файлов, загруженных этим загрузчиком за всё',
			'    время (длину self.uploaded)."""',
			'',
			'    def __init__(self, transport):',
			'        self.transport = transport',
			'        self.uploaded = []',
			'',
			'    async def _upload(self, name):',
			'        await self.transport(name)',
			'        self.uploaded.append(name)',
			'',
			'    async def upload_all(self, files):',
			'        tasks = [asyncio.ensure_future(self._upload(f)) for f in files]',
			'        await asyncio.gather(*tasks)',
			'        return len(self.uploaded)'
		],
		checks: [
			'up_sent = []',
			'async def up_transport(name):',
			'    for _ in range(len(name)):',
			'        await asyncio.sleep(0)',
			'    up_sent.append(name)',
			'async def _uploads():',
			'    u = Uploader(up_transport)',
			'    first = await u.upload_all(["a.txt", "report.pdf", "b"])',
			'    second = await u.upload_all(["c.csv"])',
			'    return first, second, sorted(up_sent)',
			'assert asyncio.run(_uploads()) == (3, 4, ["a.txt", "b", "c.csv", "report.pdf"])'
		],
		defects: [
			{
				kind: 'publish-order',
				at: '        await asyncio.gather(*tasks)',
				text: '        await tasks[0]',
				neighbour: { at: '        return len(self.uploaded)', text: '        return len(list(self.uploaded))' }
			}
		]
	}
];

/** Classes of the reserve class X: they serve only its instances, so the instances of the other classes stay as they were. */
const MIDDLE_X: Unit[] = [
	{
		lines: [
			'class Fanout:',
			'    """send_all(users) рассылает уведомления одновременно и возвращает число доставленных; transport(user)',
			'    возвращает True (доставлено) или False (получатель отписан), а при сбое бросает исключение — тогда',
			'    send_all тоже завершается этой ошибкой."""',
			'',
			'    def __init__(self, transport):',
			'        self.transport = transport',
			'',
			'    async def send_all(self, users):',
			'        results = await asyncio.gather(*(self.transport(u) for u in users))',
			'        return sum(1 for delivered in results if delivered)'
		],
		checks: [
			'async def fo_transport(user):',
			'    await asyncio.sleep(0)',
			'    if user == "down":',
			'        raise ConnectionError(user)',
			'    return user != "optout"',
			'async def fo_run():',
			'    fo = Fanout(fo_transport)',
			'    sent = await fo.send_all(["ann", "optout", "bob"])',
			'    try:',
			'        await fo.send_all(["ann", "down"])',
			'        return sent, "no error"',
			'    except ConnectionError:',
			'        return sent, "error"',
			'assert asyncio.run(fo_run()) == (2, "error")'
		],
		defects: [
			{
				kind: 'task-errors',
				at: '        results = await asyncio.gather(*(self.transport(u) for u in users))',
				text: '        results = await asyncio.gather(*(self.transport(u) for u in users), return_exceptions=True)',
				neighbour: {
					at: '        return sum(1 for delivered in results if delivered)',
					text: '        return len([delivered for delivered in results if delivered])'
				}
			}
		]
	},
	{
		lines: [
			'class Indexer:',
			'    """reindex(ids) переиндексирует документы одновременно и возвращает отсортированный список id, для',
			'    которых index(id) бросил ValueError (битый документ); любые другие ошибки выходят наружу."""',
			'',
			'    def __init__(self, index):',
			'        self.index = index',
			'',
			'    async def _one(self, doc_id):',
			'        try:',
			'            await self.index(doc_id)',
			'        except ValueError:',
			'            return doc_id',
			'        return None',
			'',
			'    async def reindex(self, ids):',
			'        results = await asyncio.gather(*(self._one(i) for i in ids))',
			'        return sorted(r for r in results if r is not None)'
		],
		checks: [
			'async def ix_index(doc_id):',
			'    await asyncio.sleep(0)',
			'    if doc_id % 5 == 0:',
			'        raise ValueError(doc_id)',
			'    if doc_id == 7:',
			'        raise KeyError(doc_id)',
			'async def ix_run():',
			'    ix = Indexer(ix_index)',
			'    broken = await ix.reindex([10, 3, 5])',
			'    try:',
			'        await ix.reindex([1, 7])',
			'        return broken, "no error"',
			'    except KeyError:',
			'        return broken, "error"',
			'assert asyncio.run(ix_run()) == ([5, 10], "error")'
		],
		defects: [
			{
				kind: 'task-errors',
				at: '        except ValueError:',
				text: '        except Exception:',
				neighbour: { at: '        return None', text: '        return' }
			}
		]
	},
	{
		lines: [
			'class AuditLog:',
			'    """record(event) дописывает событие в хранилище и возвращается, когда оно записано; ошибка',
			'    записи выходит наружу из record."""',
			'',
			'    def __init__(self, store):',
			'        self.store = store',
			'',
			'    async def record(self, event):',
			'        if not event:',
			'            raise ValueError("empty event")',
			'        await self.store.append(event)'
		],
		checks: [
			'class AlStore:',
			'    def __init__(self):',
			'        self.events = []',
			'    async def append(self, event):',
			'        await asyncio.sleep(0)',
			'        if event == "too-big":',
			'            raise OSError("quota")',
			'        self.events.append(event)',
			'async def al_run():',
			'    log = AuditLog(AlStore())',
			'    await log.record("login")',
			'    seen = list(log.store.events)',
			'    try:',
			'        await log.record("too-big")',
			'        return seen, "no error"',
			'    except OSError:',
			'        return seen, "error"',
			'assert asyncio.run(al_run()) == (["login"], "error")'
		],
		defects: [
			{
				kind: 'task-errors',
				at: '        await self.store.append(event)',
				text: '        asyncio.ensure_future(self.store.append(event))',
				neighbour: { at: '            raise ValueError("empty event")', text: '            raise ValueError(event)' }
			}
		]
	}
];

const SENIOR_X: Unit[] = [
	{
		lines: [
			'class Worker:',
			'    """run() обрабатывает задания из очереди, пока задачу не отменят. При отмене текущее задание',
			'    возвращается в очередь, а сама отмена выходит наружу: задача завершается как отменённая."""',
			'',
			'    def __init__(self, queue):',
			'        self.queue = queue',
			'        self.done = []',
			'',
			'    async def run(self):',
			'        while True:',
			'            job = await self.queue.get()',
			'            try:',
			'                await asyncio.sleep(0)',
			'                self.done.append(job)',
			'            except asyncio.CancelledError:',
			'                self.queue.put_nowait(job)',
			'                raise'
		],
		checks: [
			'async def wk_run():',
			'    q = asyncio.Queue()',
			'    for job in ("a", "b", "c"):',
			'        q.put_nowait(job)',
			'    w = Worker(q)',
			'    task = asyncio.ensure_future(w.run())',
			'    await asyncio.sleep(0)',
			'    await asyncio.sleep(0)',
			'    task.cancel()',
			'    try:',
			'        await task',
			'        cancelled = False',
			'    except asyncio.CancelledError:',
			'        cancelled = True',
			'    return cancelled, w.done, q.qsize()',
			'assert asyncio.run(wk_run()) == (True, ["a"], 2)'
		],
		defects: [
			{
				kind: 'cancellation',
				at: '                raise',
				text: '                break',
				neighbour: { at: '                self.done.append(job)', text: '                self.done += [job]' }
			},
			{
				kind: 'cancellation',
				at: '            except asyncio.CancelledError:',
				text: '            except Exception:',
				neighbour: {
					at: '            job = await self.queue.get()',
					text: '            job = (await self.queue.get())'
				}
			}
		]
	},
	{
		lines: [
			'class Session:',
			'    """fetch(url) держит соединение открытым на время запроса и закрывает его всегда: после ответа,',
			'    при ошибке и при отмене запроса."""',
			'',
			'    def __init__(self):',
			'        self.open = 0',
			'',
			'    async def _request(self, url):',
			'        await asyncio.sleep(0)',
			'        await asyncio.sleep(0)',
			'        return url.upper()',
			'',
			'    async def fetch(self, url):',
			'        self.open += 1',
			'        try:',
			'            result = await self._request(url)',
			'        except BaseException:',
			'            self.open -= 1',
			'            raise',
			'        self.open -= 1',
			'        return result'
		],
		checks: [
			'async def ss_run():',
			'    s = Session()',
			'    assert s.open == 0',
			'    task = asyncio.ensure_future(s.fetch("a"))',
			'    await asyncio.sleep(0)',
			'    task.cancel()',
			'    try:',
			'        await task',
			'    except asyncio.CancelledError:',
			'        pass',
			'    after_cancel = s.open',
			'    return after_cancel, await s.fetch("b"), s.open',
			'assert asyncio.run(ss_run()) == (0, "B", 0)'
		],
		defects: [
			{
				kind: 'cancellation',
				at: '        except BaseException:',
				text: '        except Exception:',
				neighbour: { at: '        return result', text: '        return str(result)' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Асинхронные сервисы заказов',
	'Слой доступа к данным на asyncio',
	'Фоновые задачи и кэши сервиса',
	'Обработчики платёжного шлюза'
];
const OPTIONAL_IMPORTS = ['import logging', 'import time', 'import json'];
const HEADER_CONSTANTS = [
	'POOL_SIZE = 10',
	'CACHE_TTL = 300',
	'QUEUE_LIMIT = 1000',
	'SERVICE = "orders"',
	'RETRY_LIMIT = 3',
	'BATCH = 50'
];

/** The index of the line `at` in a unit; it must occur exactly once. */
function lineOf(unit: Unit, at: string): number {
	const index = unit.lines.indexOf(at);
	if (index === -1 || unit.lines.lastIndexOf(at) !== index) throw new Error(`line not unique in its unit: ${at}`);
	return index;
}

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
	/** The awaited call of the defective class dropped instead of fixing the defect line, or null. */
	dropped: { line: number; text: string } | null;
	/** Accepted other repairs: absolute line and its replacement. */
	alternatives: { line: number; fix: string }[];
}

function compose(rng: Rng, library: readonly Unit[], kind: string, contextCount: number): Program {
	const candidates = library.flatMap((unit) =>
		unit.defects.filter((d) => d.kind === kind).map((defect) => ({ unit, defect }))
	);
	const { unit: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((unit) => unit !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A module header of random length, so the defect's line number carries no hint.
	const imports = rng.sample(OPTIONAL_IMPORTS, rng.int(0, 2));
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 4));
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		'',
		...['import asyncio', ...imports].sort(),
		...(constants.length ? ['', ...constants] : []),
		'',
		''
	];
	const defectLine = lineOf(buggy, defect.at);
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	let other = { line: 0, text: '' };
	let alternatives: Program['alternatives'] = [];
	let dropped: Program['dropped'] = null;
	for (const unit of order) {
		const offset = lines.length;
		unit.lines.forEach((line, i) => lines.push(unit === buggy && i === defectLine ? defect.text : line));
		if (unit === buggy) {
			answer = offset + defectLine + 1;
			alternatives = (defect.alternatives ?? []).map((a) => ({ line: offset + lineOf(buggy, a.at) + 1, fix: a.text }));
			const awaited = buggy.lines.findIndex((line, i) => i !== defectLine && /^\s+await /.test(line));
			if (awaited !== -1) {
				const line = buggy.lines[awaited] ?? '';
				dropped = { line: offset + awaited + 1, text: `${line.slice(0, line.length - line.trimStart().length)}pass` };
			}
			neighbour = { line: offset + lineOf(buggy, defect.neighbour.at) + 1, text: defect.neighbour.text };
		} else if (other.line === 0) {
			const sibling = unit.defects[0];
			if (sibling) other = { line: offset + lineOf(unit, sibling.at) + 1, text: sibling.text };
		}
		lines.push('', '');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const fix = buggy.lines[defectLine] ?? '';
	const checks = order.flatMap((unit) => unit.checks);
	const check = [
		'def _spec():',
		...checks.map((c) => `    ${c}`),
		'',
		'try:',
		'    _spec()',
		"    print('ok')",
		'except Exception as exc:',
		"    print('fail', type(exc).__name__)"
	].join('\n');
	return { source: lines.join('\n'), check, answer, fix, neighbour, other, alternatives, dropped };
}

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const reserve = cls.form === 'X';
	const p =
		input.grade === 'middle'
			? compose(rng, reserve ? [...MIDDLE, ...MIDDLE_X] : MIDDLE, input.classId, 2)
			: compose(rng, reserve ? [...SENIOR, ...SENIOR_X] : SENIOR, input.classId, 3);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль асинхронного сервиса на Python 3 (asyncio). У каждого класса в строке документации записан его ' +
				'контракт — в том числе при одновременных вызовах из разных задач одного цикла событий. В модуле один дефект. ' +
				'Введите номер строки с дефектом (нумерация с 1). Если исправить можно в нескольких строках — засчитывается любая ' +
				'из них, где замена одной инструкцией Python (без `;`) восстанавливает спецификацию. Исправление — одна простая инструкция того же вида, что исправляемая строка: не добавляйте ' +
				'конструкций, которых в ней нет (`:=`, lambda, обёртки, новые функции), и не переносите в неё логику из другой строки.',
			code: { language: 'python3', source: p.source }
		},
		answer: {
			kind: 'line_no',
			value: p.answer,
			...(p.alternatives.length ? { alternatives: p.alternatives.map((a) => a.line) } : {})
		}
	});
	return {
		instance,
		reference: () => ({
			kind: 'bug',
			check: p.check,
			fix: p.fix,
			...(p.alternatives.length ? { alternatives: p.alternatives } : {})
		}),
		wrong: () => ({
			'neighbour-line': { kind: 'line', line: p.neighbour.line, replacement: p.neighbour.text },
			'other-class': p.other.line === 0 ? null : { kind: 'line', line: p.other.line, replacement: p.other.text },
			'drop-await': p.dropped === null ? null : { kind: 'line', line: p.dropped.line, replacement: p.dropped.text }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
