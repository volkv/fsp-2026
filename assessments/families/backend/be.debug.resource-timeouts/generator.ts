// A module of client-side reliability code: retries, timeouts and deadlines, resources that must be released, error
// handling — each function with its contract in the docstring; exactly one line breaks its function's contract. The
// candidate names that line. Time is injected (`clock`, `sleep`), resources are fakes, so every defect shows
// deterministically. The defect's kind is the essential class; the other functions, their order and the module
// header are surface.
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
}

/** A function of the module: its lines, the checks of its contract and its possible defects. */
interface Unit {
	lines: string[];
	/** Python statements, each raising when the contract is broken. */
	checks: string[];
	defects: Defect[];
}

/** Check lines asserting that a call raises the given exception. */
function raises(call: string, error: string, message: string): string[] {
	return [
		'try:',
		`    ${call}`,
		`    raise AssertionError(${JSON.stringify(message)})`,
		`except ${error}:`,
		'    pass'
	];
}

const MIDDLE: Unit[] = [
	{
		lines: [
			'def with_retries(op, attempts, delay_ms, sleep):',
			'    """Вызывает op до attempts раз, пока она бросает ConnectionError; другие ошибки выходят',
			'    наружу сразу. Между попытками ждёт delay_ms миллисекунд, каждый раз удваивая паузу;',
			'    sleep(seconds) принимает секунды. После последней неудачи ConnectionError выходит наружу."""',
			'    pause = delay_ms',
			'    for attempt in range(attempts):',
			'        try:',
			'            return op()',
			'        except ConnectionError:',
			'            if attempt == attempts - 1:',
			'                raise',
			'            sleep(pause / 1000)',
			'            pause *= 2'
		],
		checks: [
			'wr_slept = []',
			'wr_calls = []',
			'def wr_flaky():',
			'    wr_calls.append(1)',
			'    if len(wr_calls) < 3:',
			'        raise ConnectionError()',
			'    return "ok"',
			'assert with_retries(wr_flaky, 3, 150, wr_slept.append) == "ok"',
			'assert wr_slept == [0.15, 0.3]',
			'def wr_bug():',
			'    wr_calls.append(2)',
			'    raise ValueError()',
			'wr_calls.clear()',
			...raises('with_retries(wr_bug, 3, 150, wr_slept.append)', 'ValueError', 'no ValueError'),
			'assert wr_calls == [2]'
		],
		defects: [
			{
				kind: 'units',
				at: '            sleep(pause / 1000)',
				text: '            sleep(pause)',
				neighbour: { at: '            pause *= 2', text: '            pause = pause * 2' }
			},
			{
				kind: 'units',
				at: '            sleep(pause / 1000)',
				text: '            sleep(pause // 1000)',
				neighbour: { at: '    pause = delay_ms', text: '    pause = int(delay_ms)' }
			},
			{
				kind: 'broad-except',
				at: '        except ConnectionError:',
				text: '        except Exception:',
				neighbour: { at: '            if attempt == attempts - 1:', text: '            if attempt >= attempts - 1:' }
			}
		]
	},
	{
		lines: [
			'def socket_timeout(config):',
			'    """Таймаут для socket.settimeout в секундах; в config["timeout_ms"] он задан в миллисекундах,',
			'    по умолчанию — 2500 мс."""',
			'    return config.get("timeout_ms", 2500) / 1000'
		],
		checks: ['assert socket_timeout({}) == 2.5', 'assert socket_timeout({"timeout_ms": 400}) == 0.4'],
		defects: [
			{
				kind: 'units',
				at: '    return config.get("timeout_ms", 2500) / 1000',
				text: '    return config.get("timeout_ms", 2.5) / 1000',
				neighbour: { at: 'def socket_timeout(config):', text: 'def socket_timeout(config=None):' }
			},
			{
				kind: 'units',
				at: '    return config.get("timeout_ms", 2500) / 1000',
				text: '    return config.get("timeout_ms", 2500) * 1000',
				neighbour: { at: 'def socket_timeout(config):', text: 'def socket_timeout(config={}):' }
			}
		]
	},
	{
		lines: [
			'def expired(started_ms, now_ms, ttl_s):',
			'    """started_ms и now_ms — метки времени в миллисекундах, ttl_s — срок в секундах.',
			'    True, если с начала прошло не меньше срока."""',
			'    return now_ms - started_ms >= ttl_s * 1000'
		],
		checks: ['assert expired(1000, 3000, 2)', 'assert not expired(1000, 2999, 2)'],
		defects: [
			{
				kind: 'units',
				at: '    return now_ms - started_ms >= ttl_s * 1000',
				text: '    return now_ms - started_ms >= ttl_s',
				neighbour: { at: 'def expired(started_ms, now_ms, ttl_s):', text: 'def expired(started_ms, now_ms, ttl_s=1):' }
			}
		]
	},
	{
		lines: [
			'def retry_after_ms(headers, default_ms):',
			'    """Пауза перед повтором в миллисекундах: из заголовка Retry-After (целое число секунд),',
			'    без заголовка — default_ms."""',
			'    value = headers.get("Retry-After")',
			'    if value is None:',
			'        return default_ms',
			'    return int(value) * 1000'
		],
		checks: ['assert retry_after_ms({"Retry-After": "3"}, 500) == 3000', 'assert retry_after_ms({}, 500) == 500'],
		defects: [
			{
				kind: 'units',
				at: '    return int(value) * 1000',
				text: '    return int(value)',
				neighbour: { at: '    if value is None:', text: '    if not value:' }
			},
			{
				kind: 'units',
				at: '        return default_ms',
				text: '        return default_ms * 1000',
				neighbour: {
					at: '    value = headers.get("Retry-After")',
					text: '    value = headers.get("Retry-After", None)'
				}
			}
		]
	},
	{
		lines: [
			'def read_header(open_file, path):',
			'    """Первая строка файла без перевода строки. Файл закрывается всегда — и когда чтение',
			'    падает с ошибкой; ошибка выходит наружу."""',
			'    handle = open_file(path)',
			'    try:',
			'        return handle.readline().rstrip("\\n")',
			'    finally:',
			'        handle.close()'
		],
		checks: [
			'class RhFile:',
			'    def __init__(self, text, broken=False):',
			'        self.text, self.broken, self.closed = text, broken, False',
			'    def readline(self):',
			'        if self.broken:',
			'            raise OSError("disk")',
			'        return self.text.split("\\n")[0] + "\\n"',
			'    def close(self):',
			'        self.closed = True',
			'rh_files = {"a": RhFile("id,name\\n1,x"), "b": RhFile("", broken=True)}',
			'assert read_header(rh_files.get, "a") == "id,name"',
			'assert rh_files["a"].closed',
			...raises('read_header(rh_files.get, "b")', 'OSError', 'no OSError'),
			'assert rh_files["b"].closed'
		],
		defects: [
			{
				kind: 'cleanup',
				at: '    finally:',
				text: '    except OSError:',
				neighbour: {
					at: '        return handle.readline().rstrip("\\n")',
					text: '        return handle.readline().strip()'
				}
			}
		]
	},
	{
		lines: [
			'def run_query(pool, sql, stats):',
			'    """Берёт соединение из пула, выполняет запрос и возвращает строки. Соединение возвращается',
			'    в пул всегда, в том числе при TimeoutError; таймауты считаются в stats["timeouts"],',
			'    ошибка выходит наружу."""',
			'    conn = pool.acquire()',
			'    try:',
			'        rows = conn.execute(sql)',
			'    except TimeoutError:',
			'        stats["timeouts"] += 1',
			'        raise',
			'    finally:',
			'        pool.release(conn)',
			'    return rows'
		],
		checks: [
			'class RqConn:',
			'    def execute(self, sql):',
			'        if sql == "SLOW":',
			'            raise TimeoutError()',
			'        return [sql]',
			'class RqPool:',
			'    def __init__(self):',
			'        self.free = [RqConn()]',
			'    def acquire(self):',
			'        return self.free.pop()',
			'    def release(self, conn):',
			'        self.free.append(conn)',
			'rq_pool, rq_stats = RqPool(), {"timeouts": 0}',
			'assert run_query(rq_pool, "SELECT 1", rq_stats) == ["SELECT 1"]',
			...raises('run_query(rq_pool, "SLOW", rq_stats)', 'TimeoutError', 'no TimeoutError'),
			'assert len(rq_pool.free) == 1 and rq_stats == {"timeouts": 1}'
		],
		defects: [
			{
				kind: 'cleanup',
				at: '    finally:',
				text: '    else:',
				neighbour: { at: '        stats["timeouts"] += 1', text: '        stats["timeouts"] = stats["timeouts"] + 1' }
			}
		]
	},
	{
		lines: [
			'def count_lines(open_file, path):',
			'    """Число строк файла; файл закрывается всегда."""',
			'    handle = open_file(path)',
			'    try:',
			'        count = sum(1 for _ in handle)',
			'    finally:',
			'        handle.close()',
			'    return count'
		],
		checks: [
			'class ClFile:',
			'    def __init__(self, lines):',
			'        self.lines, self.closed = lines, False',
			'    def __iter__(self):',
			'        return iter(self.lines)',
			'    def close(self):',
			'        self.closed = True',
			'cl_file = ClFile(["a", "b", "c"])',
			'assert count_lines(lambda path: cl_file, "x") == 3',
			'assert cl_file.closed'
		],
		defects: [
			{
				kind: 'cleanup',
				at: '        handle.close()',
				text: '        handle.close',
				neighbour: { at: '        count = sum(1 for _ in handle)', text: '        count = len(list(handle))' }
			}
		]
	},
	{
		lines: [
			'def load_settings(read, path):',
			'    """Настройки из JSON-файла. Нет файла (FileNotFoundError) — пустой словарь; любые другие',
			'    ошибки (нет прав на чтение, битый JSON) выходят наружу."""',
			'    try:',
			'        text = read(path)',
			'    except FileNotFoundError:',
			'        return {}',
			'    return json.loads(text)'
		],
		checks: [
			'def ls_read(path):',
			'    if path == "missing":',
			'        raise FileNotFoundError(path)',
			'    if path == "locked":',
			'        raise PermissionError(path)',
			'    return {"ok": \'{"port": 80}\', "bad": "{port"}[path]',
			'assert load_settings(ls_read, "ok") == {"port": 80}',
			'assert load_settings(ls_read, "missing") == {}',
			...raises('load_settings(ls_read, "locked")', 'PermissionError', 'no PermissionError'),
			...raises('load_settings(ls_read, "bad")', 'ValueError', 'no ValueError')
		],
		defects: [
			{
				kind: 'broad-except',
				at: '    except FileNotFoundError:',
				text: '    except OSError:',
				neighbour: { at: '        return {}', text: '        return dict()' }
			},
			{
				kind: 'broad-except',
				at: '    except FileNotFoundError:',
				text: '    except Exception:',
				neighbour: { at: '    return json.loads(text)', text: '    return json.loads(text.strip())' }
			}
		]
	},
	{
		lines: [
			'def int_or_default(value, default):',
			'    """Целое из строки; если строка не число — default. Другие ошибки (например, value=None)',
			'    выходят наружу."""',
			'    try:',
			'        return int(value)',
			'    except ValueError:',
			'        return default'
		],
		checks: [
			'assert int_or_default("42", 0) == 42',
			'assert int_or_default("4x", 7) == 7',
			...raises('int_or_default(None, 7)', 'TypeError', 'no TypeError')
		],
		defects: [
			{
				kind: 'broad-except',
				at: '    except ValueError:',
				text: '    except (ValueError, TypeError):',
				neighbour: { at: '        return int(value)', text: '        return int(str(value))' }
			},
			{
				kind: 'broad-except',
				at: '    except ValueError:',
				text: '    except Exception:',
				neighbour: { at: '        return default', text: '        return int(default)' }
			}
		]
	},
	{
		lines: [
			'def drain(items, handle):',
			'    """Обрабатывает элементы по порядку. Если handle бросает ValueError, элемент уходит',
			'    в отклонённые и обработка продолжается; другие исключения останавливают обработку',
			'    и выходят наружу. Возвращает отклонённые."""',
			'    rejected = []',
			'    for item in items:',
			'        try:',
			'            handle(item)',
			'        except ValueError:',
			'            rejected.append(item)',
			'    return rejected'
		],
		checks: [
			'dr_done = []',
			'def dr_handle(item):',
			'    if item == "bad":',
			'        raise ValueError(item)',
			'    if item == "crash":',
			'        raise KeyError(item)',
			'    dr_done.append(item)',
			'assert drain(["a", "bad", "b"], dr_handle) == ["bad"]',
			...raises('drain(["c", "crash", "d"], dr_handle)', 'KeyError', 'no KeyError'),
			'assert dr_done == ["a", "b", "c"]'
		],
		defects: [
			{
				kind: 'broad-except',
				at: '        except ValueError:',
				text: '        except Exception:',
				neighbour: { at: '            rejected.append(item)', text: '            rejected += [item]' }
			}
		]
	}
];

const SENIOR: Unit[] = [
	{
		lines: [
			'def call_with_deadline(op, attempts, deadline_ms, pause_ms, clock, sleep):',
			'    """op(timeout_ms) — запрос; при неудаче бросает TimeoutError. Не больше attempts попыток в пределах',
			'    общего срока deadline_ms от начала вызова: таймаут попытки — остаток срока, пауза между',
			'    попытками — pause_ms, но не дольше остатка срока. clock() — время в мс, sleep(ms) — пауза в мс.',
			'    Срок или попытки кончились — TimeoutError."""',
			'    start = clock()',
			'    for attempt in range(attempts):',
			'        left = deadline_ms - (clock() - start)',
			'        if left <= 0:',
			'            break',
			'        try:',
			'            return op(left)',
			'        except TimeoutError:',
			'            if attempt < attempts - 1:',
			'                sleep(min(pause_ms, max(0, deadline_ms - (clock() - start))))',
			'    raise TimeoutError("deadline exceeded")'
		],
		checks: [
			'cd_t = [5000]',
			'cd_timeouts = []',
			'def cd_clock():',
			'    return cd_t[0]',
			'def cd_sleep(ms):',
			'    cd_t[0] += ms',
			'def cd_slow(timeout_ms):',
			'    cd_timeouts.append(timeout_ms)',
			'    cd_t[0] += min(timeout_ms, 300)',
			'    raise TimeoutError()',
			...raises('call_with_deadline(cd_slow, 5, 1000, 250, cd_clock, cd_sleep)', 'TimeoutError', 'no timeout'),
			'assert cd_timeouts == [1000, 450], cd_timeouts',
			'assert cd_t[0] - 5000 <= 1000',
			'cd_answers = iter([TimeoutError(), "ok"])',
			'def cd_flaky(timeout_ms):',
			'    cd_t[0] += 100',
			'    answer = next(cd_answers)',
			'    if isinstance(answer, Exception):',
			'        raise answer',
			'    return answer',
			'assert call_with_deadline(cd_flaky, 3, 1000, 50, cd_clock, cd_sleep) == "ok"'
		],
		defects: [
			{
				kind: 'deadline',
				at: '        left = deadline_ms - (clock() - start)',
				text: '        left = deadline_ms',
				neighbour: { at: '        if left <= 0:', text: '        if left < 1:' }
			},
			{
				kind: 'deadline',
				at: '        left = deadline_ms - (clock() - start)',
				text: '        left = deadline_ms - clock()',
				neighbour: { at: '    start = clock()', text: '    start = int(clock())' }
			},
			{
				kind: 'deadline',
				at: '                sleep(min(pause_ms, max(0, deadline_ms - (clock() - start))))',
				text: '                sleep(pause_ms)',
				neighbour: { at: '            if attempt < attempts - 1:', text: '            if attempt + 1 < attempts:' }
			}
		]
	},
	{
		lines: [
			'def fetch_profile(client, user_id, budget_ms, clock):',
			'    """Профиль и заказы пользователя двумя запросами подряд в пределах общего бюджета budget_ms:',
			'    первый запрос получает весь бюджет, второй — его остаток. Если остатка нет (0 или меньше),',
			'    второй запрос не отправляется — TimeoutError."""',
			'    started = clock()',
			'    profile = client.get(f"/users/{user_id}", timeout_ms=budget_ms)',
			'    left = budget_ms - (clock() - started)',
			'    if left <= 0:',
			'        raise TimeoutError("budget exhausted")',
			'    orders = client.get(f"/users/{user_id}/orders", timeout_ms=left)',
			'    return profile, orders'
		],
		checks: [
			'class FpClient:',
			'    def __init__(self, costs):',
			'        self.now, self.costs, self.calls = 100, costs, []',
			'    def clock(self):',
			'        return self.now',
			'    def get(self, path, timeout_ms):',
			'        self.calls.append((path, timeout_ms))',
			'        self.now += self.costs[path]',
			'        return path',
			'fp = FpClient({"/users/7": 300, "/users/7/orders": 100})',
			'assert fetch_profile(fp, 7, 1000, fp.clock) == ("/users/7", "/users/7/orders")',
			'assert fp.calls == [("/users/7", 1000), ("/users/7/orders", 700)]',
			'fp2 = FpClient({"/users/8": 500, "/users/8/orders": 10})',
			...raises('fetch_profile(fp2, 8, 500, fp2.clock)', 'TimeoutError', 'no timeout'),
			'assert fp2.calls == [("/users/8", 500)]'
		],
		defects: [
			{
				kind: 'deadline',
				at: '    orders = client.get(f"/users/{user_id}/orders", timeout_ms=left)',
				text: '    orders = client.get(f"/users/{user_id}/orders", timeout_ms=budget_ms)',
				neighbour: { at: '    return profile, orders', text: '    return (profile, orders)' }
			},
			{
				kind: 'deadline',
				at: '    if left <= 0:',
				text: '    if left < 0:',
				neighbour: {
					at: '        raise TimeoutError("budget exhausted")',
					text: '        raise TimeoutError(f"budget exhausted: {left}")'
				}
			}
		]
	},
	{
		lines: [
			'def poll_until(check, interval_ms, timeout_ms, clock, sleep):',
			'    """Вызывает check() каждые interval_ms, пока она не вернёт True. Общий срок — timeout_ms от',
			'    начала; последняя пауза укорачивается до срока, в момент срока check вызывается последний',
			'    раз. True — дождались, False — срок вышел."""',
			'    deadline = clock() + timeout_ms',
			'    while True:',
			'        if check():',
			'            return True',
			'        left = deadline - clock()',
			'        if left <= 0:',
			'            return False',
			'        sleep(min(interval_ms, left))'
		],
		checks: [
			'pu_t = [7000]',
			'pu_seen = []',
			'def pu_sleep(ms):',
			'    pu_t[0] += ms',
			'def pu_ready_at(moment):',
			'    def check():',
			'        pu_seen.append(pu_t[0])',
			'        return pu_t[0] >= moment',
			'    return check',
			'assert not poll_until(pu_ready_at(8100), 300, 1000, lambda: pu_t[0], pu_sleep)',
			'assert pu_seen == [7000, 7300, 7600, 7900, 8000], pu_seen',
			'pu_t[0] = 7000',
			'assert poll_until(pu_ready_at(7600), 300, 1000, lambda: pu_t[0], pu_sleep)'
		],
		defects: [
			{
				kind: 'deadline',
				at: '        sleep(min(interval_ms, left))',
				text: '        sleep(interval_ms)',
				neighbour: { at: '        if left <= 0:', text: '        if left < 0 or left == 0:' }
			},
			{
				kind: 'deadline',
				at: '    deadline = clock() + timeout_ms',
				text: '    deadline = timeout_ms',
				neighbour: { at: '        left = deadline - clock()', text: '        left = -(clock() - deadline)' }
			}
		]
	},
	{
		lines: [
			'def submit_payment(gateway, payment, attempts):',
			'    """Списание по платежу, до attempts попыток. Повтор только при ConnectionRefusedError (запрос',
			'    не дошёл до шлюза); после последней такой неудачи ошибка выходит наружу. При TimeoutError',
			'    ответ потерян, а списание могло пройти: повтора нет, возвращается gateway.status(id платежа).',
			'    Любая другая ошибка выходит наружу сразу."""',
			'    for attempt in range(attempts):',
			'        try:',
			'            return gateway.charge(payment)',
			'        except ConnectionRefusedError:',
			'            if attempt == attempts - 1:',
			'                raise',
			'        except TimeoutError:',
			'            return gateway.status(payment["id"])'
		],
		checks: [
			'class SpGateway:',
			'    def __init__(self, script):',
			'        self.script, self.charges = list(script), []',
			'    def charge(self, payment):',
			'        outcome = self.script.pop(0)',
			'        if outcome == "refused":',
			'            raise ConnectionRefusedError()',
			'        self.charges.append(payment["id"])',
			'        if outcome == "timeout":',
			'            raise TimeoutError()',
			'        if outcome == "reset":',
			'            raise ConnectionResetError()',
			'        return "paid"',
			'    def status(self, pid):',
			'        return "paid" if pid in self.charges else "none"',
			'sp = SpGateway(["refused", "timeout", "ok"])',
			'assert submit_payment(sp, {"id": 5}, 3) == "paid" and sp.charges == [5]',
			'sp2 = SpGateway(["reset", "ok"])',
			...raises('submit_payment(sp2, {"id": 6}, 3)', 'ConnectionResetError', 'retried after reset'),
			'assert sp2.charges == [6]',
			'sp3 = SpGateway(["refused", "refused", "ok"])',
			...raises('submit_payment(sp3, {"id": 7}, 2)', 'ConnectionRefusedError', 'no error after the last attempt')
		],
		defects: [
			{
				kind: 'idempotency',
				at: '        except ConnectionRefusedError:',
				text: '        except (ConnectionRefusedError, TimeoutError):',
				neighbour: {
					at: '            return gateway.status(payment["id"])',
					text: '            return gateway.status(payment.get("id"))'
				}
			},
			{
				kind: 'idempotency',
				at: '        except ConnectionRefusedError:',
				text: '        except ConnectionError:',
				neighbour: { at: '            if attempt == attempts - 1:', text: '            if attempt + 1 == attempts:' }
			}
		]
	},
	{
		lines: [
			'def create_order(api, cart, attempts, new_key):',
			'    """POST /orders с заголовком Idempotency-Key; при TimeoutError повтор, не больше attempts',
			'    попыток. Все попытки одного заказа идут с одним ключом — сервер не создаст дубль."""',
			'    key = new_key()',
			'    for attempt in range(attempts):',
			'        try:',
			'            return api.post("/orders", cart, headers={"Idempotency-Key": key})',
			'        except TimeoutError:',
			'            if attempt == attempts - 1:',
			'                raise'
		],
		checks: [
			'class CoApi:',
			'    def __init__(self):',
			'        self.orders, self.calls = {}, 0',
			'    def post(self, path, cart, headers):',
			'        self.calls += 1',
			'        key = headers["Idempotency-Key"]',
			'        if key not in self.orders:',
			'            self.orders[key] = len(self.orders) + 1',
			'        if self.calls == 1:',
			'            raise TimeoutError()',
			'        return self.orders[key]',
			'co_keys = iter(["k1", "k2", "k3"])',
			'co_api = CoApi()',
			'assert create_order(co_api, ["x"], 3, lambda: next(co_keys)) == 1',
			'assert len(co_api.orders) == 1'
		],
		defects: [
			{
				kind: 'idempotency',
				at: '            return api.post("/orders", cart, headers={"Idempotency-Key": key})',
				text: '            return api.post("/orders", cart, headers={"Idempotency-Key": new_key()})',
				neighbour: { at: '            if attempt == attempts - 1:', text: '            if attempt >= attempts - 1:' }
			}
		]
	},
	{
		lines: [
			'def send_all(sender, users, attempts):',
			'    """Отправляет уведомление каждому пользователю; sender.send(user) неидемпотентна. Повтор только',
			'    при ConnectionRefusedError, не больше attempts попыток на пользователя; после последней неудачи',
			'    ошибка выходит наружу. Возвращает список доставленных."""',
			'    delivered = []',
			'    for user in users:',
			'        for attempt in range(attempts):',
			'            try:',
			'                sender.send(user)',
			'                delivered.append(user)',
			'                break',
			'            except ConnectionRefusedError:',
			'                if attempt == attempts - 1:',
			'                    raise',
			'    return delivered'
		],
		checks: [
			'class SaSender:',
			'    def __init__(self, script):',
			'        self.script, self.sent = list(script), []',
			'    def send(self, user):',
			'        outcome = self.script.pop(0)',
			'        if outcome == "refused":',
			'            raise ConnectionRefusedError()',
			'        self.sent.append(user)',
			'        if outcome == "timeout":',
			'            raise TimeoutError()',
			'sa = SaSender(["refused", "ok", "ok"])',
			'assert send_all(sa, ["ann", "bob"], 3) == ["ann", "bob"] and sa.sent == ["ann", "bob"]',
			'sa2 = SaSender(["timeout", "ok"])',
			...raises('send_all(sa2, ["eve"], 3)', 'TimeoutError', 'retried a timeout'),
			'assert sa2.sent == ["eve"]',
			'sa3 = SaSender(["refused", "refused", "ok"])',
			...raises('send_all(sa3, ["max", "kim"], 2)', 'ConnectionRefusedError', 'error lost'),
			'assert sa3.sent == []'
		],
		defects: [
			{
				kind: 'idempotency',
				at: '            except ConnectionRefusedError:',
				text: '            except OSError:',
				neighbour: { at: '                delivered.append(user)', text: '                delivered += [user]' }
			},
			{
				kind: 'retry-scope',
				at: '                    raise',
				text: '                    continue',
				neighbour: {
					at: '                if attempt == attempts - 1:',
					text: '                if attempt + 1 == attempts:'
				}
			}
		]
	},
	{
		lines: [
			'def fetch_rates(http, attempts):',
			'    """GET /rates с повтором при ConnectionError; вызовов http.get не больше attempts. После',
			'    последней неудачи наружу выходит ConnectionError последней попытки."""',
			'    last = None',
			'    for _ in range(attempts):',
			'        try:',
			'            return http.get("/rates")',
			'        except ConnectionError as exc:',
			'            last = exc',
			'    raise last'
		],
		checks: [
			'class FrHttp:',
			'    def __init__(self, fails):',
			'        self.fails, self.calls = fails, 0',
			'    def get(self, path):',
			'        self.calls += 1',
			'        if self.calls <= self.fails:',
			'            raise ConnectionError(f"down {self.calls}")',
			'        return {"USD": 90}',
			'fr = FrHttp(2)',
			'assert fetch_rates(fr, 3) == {"USD": 90} and fr.calls == 3',
			'fr2 = FrHttp(5)',
			'try:',
			'    fetch_rates(fr2, 3)',
			'    raise AssertionError("no error")',
			'except ConnectionError as exc:',
			'    assert str(exc) == "down 3", exc',
			'assert fr2.calls == 3'
		],
		defects: [
			{
				kind: 'retry-scope',
				at: '    for _ in range(attempts):',
				text: '    for _ in range(attempts + 1):',
				neighbour: { at: '    last = None', text: '    last = ConnectionError()' }
			},
			{
				kind: 'retry-scope',
				at: '    raise last',
				text: '    raise RuntimeError("rates unavailable") from last',
				neighbour: { at: '            last = exc', text: '            last = exc.with_traceback(None)' }
			},
			{
				kind: 'retry-scope',
				at: '            last = exc',
				text: '            last = last or exc',
				neighbour: { at: '            return http.get("/rates")', text: '            return dict(http.get("/rates"))' }
			}
		]
	},
	{
		lines: [
			'def call_api(http, path, attempts):',
			'    """Повторяет GET, пока ответ 502, 503 или 504, — не больше attempts вызовов; любой другой',
			'    код (включая 500 и 4xx) возвращается сразу. Возвращает код последнего ответа."""',
			'    for _ in range(attempts):',
			'        status = http.get(path)',
			'        if status not in (502, 503, 504):',
			'            return status',
			'    return status'
		],
		checks: [
			'class CaHttp:',
			'    def __init__(self, codes):',
			'        self.codes, self.calls = list(codes), 0',
			'    def get(self, path):',
			'        self.calls += 1',
			'        return self.codes.pop(0)',
			'ca = CaHttp([503, 500, 200])',
			'assert call_api(ca, "/x", 5) == 500 and ca.calls == 2',
			'ca = CaHttp([404, 200])',
			'assert call_api(ca, "/x", 5) == 404 and ca.calls == 1',
			'ca = CaHttp([502, 504, 503, 200])',
			'assert call_api(ca, "/x", 3) == 503 and ca.calls == 3'
		],
		defects: [
			{
				kind: 'retry-scope',
				at: '        if status not in (502, 503, 504):',
				text: '        if status < 500:',
				neighbour: { at: '        status = http.get(path)', text: '        status = int(http.get(path))' }
			},
			{
				kind: 'retry-scope',
				at: '        if status not in (502, 503, 504):',
				text: '        if status == 200:',
				neighbour: { at: '            return status', text: '            return int(status)' }
			}
		]
	}
];

/** Functions of the reserve class X: they serve only its instances, so the instances of the other classes stay as they were. */
const MIDDLE_X: Unit[] = [
	{
		lines: [
			'def backoff_ms(attempt, base_ms, cap_ms):',
			'    """Пауза перед повтором после неудачной попытки номер attempt (нумерация с 1):',
			'    base_ms · 2^(attempt − 1), но не больше cap_ms."""',
			'    return min(cap_ms, base_ms * 2 ** (attempt - 1))'
		],
		checks: [
			'assert backoff_ms(1, 100, 1000) == 100',
			'assert backoff_ms(3, 100, 1000) == 400',
			'assert backoff_ms(6, 100, 1000) == 1000'
		],
		defects: [
			{
				kind: 'backoff',
				at: '    return min(cap_ms, base_ms * 2 ** (attempt - 1))',
				text: '    return min(cap_ms, base_ms * 2 ** attempt)',
				neighbour: {
					at: 'def backoff_ms(attempt, base_ms, cap_ms):',
					text: 'def backoff_ms(attempt, base_ms=100, cap_ms=10_000):'
				}
			},
			{
				kind: 'backoff',
				at: '    return min(cap_ms, base_ms * 2 ** (attempt - 1))',
				text: '    return max(cap_ms, base_ms * 2 ** (attempt - 1))',
				neighbour: {
					at: 'def backoff_ms(attempt, base_ms, cap_ms):',
					text: 'def backoff_ms(attempt, base_ms, cap_ms=None):'
				}
			}
		]
	},
	{
		lines: [
			'def retry_schedule(attempts, base_ms, factor):',
			'    """Моменты начала попыток в мс от первой: первая — в 0, перед попыткой k + 1 пауза base_ms · factor^(k − 1);',
			'    сами попытки длятся 0 мс."""',
			'    moments = [0]',
			'    pause = base_ms',
			'    for _ in range(attempts - 1):',
			'        moments.append(moments[-1] + pause)',
			'        pause *= factor',
			'    return moments'
		],
		checks: ['assert retry_schedule(4, 100, 2) == [0, 100, 300, 700]', 'assert retry_schedule(1, 100, 2) == [0]'],
		defects: [
			{
				kind: 'backoff',
				at: '        pause *= factor',
				text: '        pause = base_ms * factor',
				neighbour: { at: '    moments = [0]', text: '    moments = [0 * base_ms]' }
			},
			{
				kind: 'backoff',
				at: '        moments.append(moments[-1] + pause)',
				text: '        moments.append(pause)',
				neighbour: { at: '    pause = base_ms', text: '    pause = base_ms * 1' }
			}
		]
	}
];

const SENIOR_X: Unit[] = [
	{
		lines: [
			'class RetryBudget:',
			'    """Повторы разрешены, пока в бюджете есть хотя бы один токен: каждый успешный запрос добавляет',
			'    ratio токена (не больше cap), каждый разрешённый повтор тратит один. can_retry() проверяет и тратит."""',
			'',
			'    def __init__(self, ratio, cap):',
			'        self.ratio = ratio',
			'        self.cap = cap',
			'        self.tokens = cap',
			'',
			'    def on_success(self):',
			'        self.tokens = min(self.cap, self.tokens + self.ratio)',
			'',
			'    def can_retry(self):',
			'        if self.tokens < 1:',
			'            return False',
			'        self.tokens -= 1',
			'        return True'
		],
		checks: [
			'rb = RetryBudget(0.5, 2)',
			'assert rb.can_retry() and rb.can_retry() and not rb.can_retry()',
			'rb.on_success()',
			'assert not rb.can_retry()',
			'rb.on_success()',
			'assert rb.can_retry()',
			'for _ in range(10):',
			'    rb.on_success()',
			'assert rb.tokens == 2'
		],
		defects: [
			{
				kind: 'retry-budget',
				at: '        if self.tokens < 1:',
				text: '        if self.tokens <= 0:',
				neighbour: { at: '        return True', text: '        return self.tokens >= 0' }
			},
			{
				kind: 'retry-budget',
				at: '        self.tokens = min(self.cap, self.tokens + self.ratio)',
				text: '        self.tokens = self.tokens + self.ratio',
				neighbour: { at: '        self.tokens = cap', text: '        self.tokens = float(cap)' }
			}
		]
	},
	{
		lines: [
			'def fetch_all(fetch, keys, max_retries):',
			'    """Загружает ключи по очереди; при ConnectionError ключ повторяется, но повторов на весь вызов — не',
			'    больше max_retries (общий бюджет); бюджет кончился — ошибка выходит наружу. Результат: словарь',
			'    ключ -> (значение, число повторов этого ключа)."""',
			'    result = {}',
			'    left = max_retries',
			'    for key in keys:',
			'        tries = 0',
			'        while True:',
			'            try:',
			'                result[key] = (fetch(key), tries)',
			'                break',
			'            except ConnectionError:',
			'                if left == 0:',
			'                    raise',
			'                left -= 1',
			'                tries += 1',
			'    return result'
		],
		checks: [
			'def fa_fetcher(failures):',
			'    seen = {}',
			'    def fetch(key):',
			'        seen[key] = seen.get(key, 0) + 1',
			'        if seen[key] <= failures[key]:',
			'            raise ConnectionError(key)',
			'        return key.upper()',
			'    return fetch',
			'assert fetch_all(fa_fetcher({"a": 1, "b": 1}), ["a", "b"], 3) == {"a": ("A", 1), "b": ("B", 1)}',
			...raises('fetch_all(fa_fetcher({"a": 2, "b": 2}), ["a", "b"], 3)', 'ConnectionError', 'budget not shared')
		],
		defects: [
			{
				kind: 'retry-budget',
				at: '                if left == 0:',
				text: '                if tries == max_retries:',
				neighbour: { at: '                tries += 1', text: '                tries = tries + 1' }
			},
			{
				kind: 'retry-budget',
				at: '        tries = 0',
				text: '        tries, left = 0, max_retries',
				neighbour: { at: '    result = {}', text: '    result = dict()' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Клиент внешних сервисов',
	'Надёжность вызовов платёжного шлюза',
	'Повторы, таймауты и ресурсы',
	'Интеграционный слой сервиса заказов'
];
const OPTIONAL_IMPORTS = ['import logging', 'import time', 'import socket'];
const HEADER_CONSTANTS = [
	'DEFAULT_TIMEOUT_MS = 2000',
	'MAX_ATTEMPTS = 4',
	'BASE_DELAY_MS = 100',
	'USER_AGENT = "orders-client/2.3"',
	'POOL_SIZE = 8',
	'DEADLINE_MS = 5000'
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
		...['import json', ...imports].sort(),
		...(constants.length ? ['', ...constants] : []),
		'',
		''
	];
	const defectLine = lineOf(buggy, defect.at);
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	let other = { line: 0, text: '' };
	for (const unit of order) {
		const offset = lines.length;
		unit.lines.forEach((line, i) => lines.push(unit === buggy && i === defectLine ? defect.text : line));
		if (unit === buggy) {
			answer = offset + defectLine + 1;
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
	return { source: lines.join('\n'), check, answer, fix, neighbour, other };
}

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const library = input.grade === 'middle' ? MIDDLE : SENIOR;
	const reserve = input.grade === 'middle' ? MIDDLE_X : SENIOR_X;
	const p = compose(rng, cls.form === 'X' ? [...library, ...reserve] : library, input.classId, 3);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль клиента внешних сервисов на Python 3. Время и ресурсы функции получают параметрами (`clock`, ' +
				'`sleep`, `open_file`, пул, клиент). У каждой функции в строке документации записан её контракт. Ровно одна ' +
				'строка модуля нарушает контракт своей функции: если заменить только её, все функции будут работать по ' +
				'контракту. Введите номер этой строки (нумерация с 1).',
			code: { language: 'python3', source: p.source }
		},
		answer: { kind: 'line_no', value: p.answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'bug', check: p.check, fix: p.fix }),
		wrong: () => ({
			'neighbour-line': { kind: 'line', line: p.neighbour.line, replacement: p.neighbour.text },
			'other-function': p.other.line === 0 ? null : { kind: 'line', line: p.other.line, replacement: p.other.text }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
