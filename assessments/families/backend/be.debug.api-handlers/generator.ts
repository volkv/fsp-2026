// A module of HTTP handlers of a service: each handler takes the request's parts and its stores and returns
// (status, body), with its contract in the docstring; exactly one line breaks its handler's contract — a status code,
// validation after a write, paging or filtering, a field leaking into the response, idempotency, a transaction that
// does not cover both writes, a retry without a key, a precondition. The candidate names that line. The defect's kind
// is the essential class; the other handlers, their order and the module header are surface.
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

const JUNIOR: Unit[] = [
	{
		lines: [
			'def create_user(db, body):',
			'    """POST /users. Нет email — (422, {"error": "email required"}); email занят — (409, {"error": "exists"});',
			'    иначе пользователь сохраняется: (201, {"id": новый id, "email": email})."""',
			'    email = body.get("email")',
			'    if not email:',
			'        return 422, {"error": "email required"}',
			'    if email in db.emails():',
			'        return 409, {"error": "exists"}',
			'    user_id = db.insert({"email": email})',
			'    return 201, {"id": user_id, "email": email}'
		],
		checks: [
			'class CuDb:',
			'    def __init__(self):',
			'        self.users = []',
			'    def emails(self):',
			'        return [u["email"] for u in self.users]',
			'    def insert(self, record):',
			'        self.users.append(record)',
			'        return len(self.users)',
			'cu = CuDb()',
			'assert create_user(cu, {"email": "a@x.ru"}) == (201, {"id": 1, "email": "a@x.ru"})',
			'assert create_user(cu, {"email": "a@x.ru"}) == (409, {"error": "exists"})',
			'assert create_user(cu, {}) == (422, {"error": "email required"})',
			'assert len(cu.users) == 1'
		],
		defects: [
			{
				kind: 'status-code',
				at: '    return 201, {"id": user_id, "email": email}',
				text: '    return 200, {"id": user_id, "email": email}',
				neighbour: { at: '    email = body.get("email")', text: '    email = body.get("email", "")' }
			},
			{
				kind: 'status-code',
				at: '        return 422, {"error": "email required"}',
				text: '        return 400, {"error": "email required"}',
				neighbour: {
					at: '    user_id = db.insert({"email": email})',
					text: '    user_id = db.insert(dict(email=email))'
				}
			},
			{
				kind: 'status-code',
				at: '        return 409, {"error": "exists"}',
				text: '        return 422, {"error": "exists"}',
				neighbour: { at: '    if not email:', text: '    if email is None:' }
			}
		]
	},
	{
		lines: [
			'def post_comment(db, user, body):',
			'    """POST /comments. Текст после strip — от 1 до 500 символов, иначе (422, {"error": "bad text"}); не больше',
			'    3 комментариев пользователя за минуту, иначе (429, {"error": "slow down"}). Отклонённый запрос ничего',
			'    не меняет. Успех — (201, {"id": ..., "text": текст})."""',
			'    text = body.get("text", "").strip()',
			'    if not 1 <= len(text) <= 500:',
			'        return 422, {"error": "bad text"}',
			'    if db.recent(user) >= 3:',
			'        return 429, {"error": "slow down"}',
			'    db.bump(user)',
			'    comment_id = db.add(user, text)',
			'    return 201, {"id": comment_id, "text": text}'
		],
		checks: [
			'class PcDb:',
			'    def __init__(self):',
			'        self.counts, self.comments = {}, []',
			'    def recent(self, user):',
			'        return self.counts.get(user, 0)',
			'    def bump(self, user):',
			'        self.counts[user] = self.counts.get(user, 0) + 1',
			'        return self.counts[user]',
			'    def add(self, user, text):',
			'        self.comments.append((user, text))',
			'        return len(self.comments)',
			'pc = PcDb()',
			'for pc_i in range(3):',
			'    assert post_comment(pc, "ann", {"text": f" hi {pc_i} "})[0] == 201',
			'assert post_comment(pc, "ann", {"text": "more"}) == (429, {"error": "slow down"})',
			'assert post_comment(pc, "bob", {"text": "   "}) == (422, {"error": "bad text"})',
			'assert pc.counts == {"ann": 3} and len(pc.comments) == 3',
			'assert post_comment(pc, "bob", {"text": "ok"}) == (201, {"id": 4, "text": "ok"})'
		],
		defects: [
			{
				kind: 'status-code',
				at: '        return 429, {"error": "slow down"}',
				text: '        return 403, {"error": "slow down"}',
				neighbour: {
					at: '        return 422, {"error": "bad text"}',
					text: '        return 422, {"error": "invalid text"}'
				}
			},
			{
				kind: 'validate-after-write',
				at: '    if db.recent(user) >= 3:',
				text: '    if db.bump(user) > 3:',
				neighbour: { at: '    comment_id = db.add(user, text)', text: '    comment_id = db.add(user, text.strip())' }
			}
		]
	},
	{
		lines: [
			'def delete_item(db, item_id):',
			'    """DELETE /items/{id}. Удалён — (204, None); такого нет — (404, {"error": "not found"})."""',
			'    if not db.delete(item_id):',
			'        return 404, {"error": "not found"}',
			'    return 204, None'
		],
		checks: [
			'class DiDb:',
			'    def __init__(self):',
			'        self.items = {1: "a"}',
			'    def delete(self, item_id):',
			'        return self.items.pop(item_id, None) is not None',
			'di = DiDb()',
			'assert delete_item(di, 1) == (204, None) and delete_item(di, 1) == (404, {"error": "not found"})'
		],
		defects: [
			{
				kind: 'status-code',
				at: '    return 204, None',
				text: '    return 200, None',
				neighbour: { at: '    if not db.delete(item_id):', text: '    if db.delete(item_id) is False:' }
			}
		]
	},
	{
		lines: [
			'def rename_item(db, item_id, body):',
			'    """PATCH /items/{id}. name после strip — непустой и не длиннее 50 символов, иначе (422, {"error": "bad name"})',
			'    и товар не меняется; нет товара — (404, ...). Успех — товар сохраняется: (200, товар)."""',
			'    item = db.get(item_id)',
			'    if item is None:',
			'        return 404, {"error": "not found"}',
			'    name = body.get("name", "").strip()',
			'    updated = dict(item, name=name)',
			'    if not name or len(name) > 50:',
			'        return 422, {"error": "bad name"}',
			'    db.put(item_id, updated)',
			'    return 200, updated'
		],
		checks: [
			'class RnDb:',
			'    def __init__(self):',
			'        self.items = {1: {"id": 1, "name": "Чай", "price": 300}}',
			'    def get(self, item_id):',
			'        return self.items.get(item_id)',
			'    def put(self, item_id, item):',
			'        self.items[item_id] = item',
			'        return item',
			'rn = RnDb()',
			'assert rename_item(rn, 1, {"name": "  "}) == (422, {"error": "bad name"})',
			'assert rename_item(rn, 1, {"name": "x" * 51}) == (422, {"error": "bad name"})',
			'assert rn.items[1] == {"id": 1, "name": "Чай", "price": 300}',
			'assert rename_item(rn, 1, {"name": " Кофе "}) == (200, {"id": 1, "name": "Кофе", "price": 300})',
			'assert rename_item(rn, 2, {"name": "x"})[0] == 404'
		],
		defects: [
			{
				kind: 'validate-after-write',
				at: '    updated = dict(item, name=name)',
				text: '    updated = db.put(item_id, dict(item, name=name))',
				neighbour: {
					at: '    name = body.get("name", "").strip()',
					text: '    name = str(body.get("name", "")).strip()'
				}
			},
			{
				kind: 'validate-after-write',
				at: '    updated = dict(item, name=name)',
				text: '    updated = item.update(name=name) or item',
				neighbour: { at: '    return 200, updated', text: '    return 200, dict(updated)' }
			}
		]
	},
	{
		lines: [
			'def list_orders(db, query):',
			'    """GET /orders?status=&page=&size=. Заказы со статусом status (не задан — все) по возрастанию id;',
			'    страницы с 1, size по умолчанию 20. Ответ (200, {"items": страница, "total": число подходящих заказов})."""',
			'    status = query.get("status")',
			'    page = int(query.get("page", 1))',
			'    size = int(query.get("size", 20))',
			'    rows = [o for o in db.orders() if status is None or o["status"] == status]',
			'    rows.sort(key=lambda o: o["id"])',
			'    start = (page - 1) * size',
			'    return 200, {"items": rows[start:start + size], "total": len(rows)}'
		],
		checks: [
			'class LoDb:',
			'    def orders(self):',
			'        return [{"id": i, "status": "paid" if i % 2 else "new"} for i in (5, 2, 9, 4, 7, 1)]',
			'lo = LoDb()',
			'lo_page = list_orders(lo, {"status": "paid", "page": "2", "size": "2"})',
			'assert lo_page == (200, {"items": [{"id": 7, "status": "paid"}, {"id": 9, "status": "paid"}], "total": 4})',
			'assert list_orders(lo, {})[1]["total"] == 6'
		],
		defects: [
			{
				kind: 'paging-filter',
				at: '    start = (page - 1) * size',
				text: '    start = page * size',
				neighbour: { at: '    rows.sort(key=lambda o: o["id"])', text: '    rows.sort(key=lambda o: int(o["id"]))' }
			},
			{
				kind: 'paging-filter',
				at: '    rows = [o for o in db.orders() if status is None or o["status"] == status]',
				text: '    rows = [o for o in db.orders() if o["status"] == status]',
				neighbour: { at: '    size = int(query.get("size", 20))', text: '    size = int(query.get("size") or 20)' }
			},
			{
				kind: 'paging-filter',
				at: '    return 200, {"items": rows[start:start + size], "total": len(rows)}',
				text: '    return 200, {"items": rows[start:start + size], "total": len(db.orders())}',
				neighbour: { at: '    page = int(query.get("page", 1))', text: '    page = max(1, int(query.get("page", 1)))' }
			}
		]
	},
	{
		lines: [
			'def search_products(db, query):',
			'    """GET /products?q=. Названия товаров, содержащих q без учёта регистра, по алфавиту; скрытые товары',
			'    (hidden) не показываются никогда. Ответ (200, список названий)."""',
			'    q = query.get("q", "").lower()',
			'    found = [p["name"] for p in db.products() if q in p["name"].lower() and not p["hidden"]]',
			'    return 200, sorted(found)'
		],
		checks: [
			'class SpDb:',
			'    def products(self):',
			'        return [',
			'            {"name": "Чай зелёный", "hidden": False},',
			'            {"name": "Чайник", "hidden": True},',
			'            {"name": "Кофе", "hidden": False},',
			'            {"name": "чай чёрный", "hidden": False},',
			'        ]',
			'assert search_products(SpDb(), {"q": "Чай"}) == (200, ["Чай зелёный", "чай чёрный"])'
		],
		defects: [
			{
				kind: 'paging-filter',
				at: '    found = [p["name"] for p in db.products() if q in p["name"].lower() and not p["hidden"]]',
				text: '    found = [p["name"] for p in db.products() if q in p["name"].lower() or not p["hidden"]]',
				neighbour: { at: '    return 200, sorted(found)', text: '    return 200, sorted(set(found))' }
			},
			{
				kind: 'paging-filter',
				at: '    q = query.get("q", "").lower()',
				text: '    q = query.get("q", "")',
				neighbour: { at: '    return 200, sorted(found)', text: '    return 200, list(sorted(found))' }
			}
		]
	}
];

const JUNIOR_X: Unit[] = [
	{
		lines: [
			'def get_profile(db, user_id):',
			'    """GET /users/{id}. Публичный профиль — только поля id, name и avatar; нет пользователя —',
			'    (404, {"error": "not found"})."""',
			'    user = db.get(user_id)',
			'    if user is None:',
			'        return 404, {"error": "not found"}',
			'    return 200, {key: user[key] for key in ("id", "name", "avatar")}'
		],
		checks: [
			'class GpDb:',
			'    def get(self, user_id):',
			'        users = {1: {"id": 1, "name": "Ann", "avatar": "a.png", "email": "ann@x.ru", "password_hash": "h"}}',
			'        return users.get(user_id)',
			'assert get_profile(GpDb(), 1) == (200, {"id": 1, "name": "Ann", "avatar": "a.png"})',
			'assert get_profile(GpDb(), 2) == (404, {"error": "not found"})'
		],
		defects: [
			{
				kind: 'field-leak',
				at: '    return 200, {key: user[key] for key in ("id", "name", "avatar")}',
				text: '    return 200, dict(user)',
				neighbour: { at: '    user = db.get(user_id)', text: '    user = db.get(int(user_id))' }
			},
			{
				kind: 'field-leak',
				at: '    return 200, {key: user[key] for key in ("id", "name", "avatar")}',
				text: '    return 200, {key: user[key] for key in user if key != "password_hash"}',
				neighbour: { at: '    if user is None:', text: '    if not user:' }
			}
		]
	},
	{
		lines: [
			'def list_members(db, team_id):',
			'    """GET /teams/{id}/members. Для каждого участника — только name и role; приглашённые',
			'    (status = \'invited\') не показываются."""',
			'    members = [m for m in db.members(team_id) if m["status"] != "invited"]',
			'    return 200, [{"name": m["name"], "role": m["role"]} for m in members]'
		],
		checks: [
			'class LmDb:',
			'    def members(self, team_id):',
			'        return [',
			'            {"name": "Ann", "role": "owner", "email": "a@x.ru", "status": "active"},',
			'            {"name": "Bob", "role": "dev", "email": "b@x.ru", "status": "invited"},',
			'        ]',
			'assert list_members(LmDb(), 1) == (200, [{"name": "Ann", "role": "owner"}])'
		],
		defects: [
			{
				kind: 'field-leak',
				at: '    return 200, [{"name": m["name"], "role": m["role"]} for m in members]',
				text: '    return 200, [{k: v for k, v in m.items() if k != "email"} for m in members]',
				neighbour: {
					at: '    members = [m for m in db.members(team_id) if m["status"] != "invited"]',
					text: '    members = [m for m in db.members(team_id) if m.get("status") != "invited"]'
				}
			}
		]
	},
	{
		lines: [
			'class GatewayError(Exception):',
			'    pass',
			'',
			'',
			'def create_charge(db, gateway, body):',
			'    """POST /charges. Ошибка платёжного шлюза записывается в журнал, а клиент получает',
			'    (502, {"error": "payment failed"}) без подробностей шлюза; успех — (201, {"id": номер, "amount": сумма}).',
			'    Данные карты в ответ не попадают никогда."""',
			'    try:',
			'        result = gateway.charge(body["amount"], body["card"])',
			'    except GatewayError as exc:',
			'        db.log_error(str(exc))',
			'        return 502, {"error": "payment failed"}',
			'    charge_id = db.add(result, body["amount"])',
			'    return 201, {"id": charge_id, "amount": body["amount"]}'
		],
		checks: [
			'class CcGateway:',
			'    def charge(self, amount, card):',
			'        if amount > 1000:',
			'            raise GatewayError(f"card {card} declined: limit")',
			'        return f"tx-{amount}"',
			'class CcDb:',
			'    def __init__(self):',
			'        self.rows, self.errors = [], []',
			'    def add(self, tx, amount):',
			'        self.rows.append((tx, amount))',
			'        return len(self.rows)',
			'    def log_error(self, message):',
			'        self.errors.append(message)',
			'cc = CcDb()',
			'assert create_charge(cc, CcGateway(), {"amount": 500, "card": "4111"}) == (201, {"id": 1, "amount": 500})',
			'assert create_charge(cc, CcGateway(), {"amount": 5000, "card": "4111"}) == (502, {"error": "payment failed"})',
			'assert cc.errors == ["card 4111 declined: limit"]'
		],
		defects: [
			{
				kind: 'field-leak',
				at: '        return 502, {"error": "payment failed"}',
				text: '        return 502, {"error": str(exc)}',
				neighbour: { at: '        db.log_error(str(exc))', text: '        db.log_error(repr(exc))' }
			},
			{
				kind: 'field-leak',
				at: '    return 201, {"id": charge_id, "amount": body["amount"]}',
				text: '    return 201, {"id": charge_id, **body}',
				neighbour: {
					at: '    charge_id = db.add(result, body["amount"])',
					text: '    charge_id = db.add(result, int(body["amount"]))'
				}
			}
		]
	}
];

const MIDDLE: Unit[] = [
	{
		lines: [
			'def create_payment(db, headers, body):',
			'    """POST /payments, заголовок Idempotency-Key обязателен (иначе 400). Повтор с тем же ключом и тем же',
			'    телом возвращает сохранённый ответ — тот же код и тело — и ничего не создаёт; тот же ключ с другим',
			'    телом — (422, {"error": "key reused"}). Новый платёж — (201, {"id": ..., "amount": ...})."""',
			'    key = headers.get("Idempotency-Key")',
			'    if not key:',
			'        return 400, {"error": "key required"}',
			'    saved = db.idem.get(key)',
			'    if saved is not None:',
			'        if saved["body"] != body:',
			'            return 422, {"error": "key reused"}',
			'        return saved["status"], saved["response"]',
			'    payment_id = db.add_payment(body)',
			'    response = {"id": payment_id, "amount": body["amount"]}',
			'    db.idem[key] = {"body": body, "status": 201, "response": response}',
			'    return 201, response'
		],
		checks: [
			'class CpDb:',
			'    def __init__(self):',
			'        self.idem, self.payments = {}, []',
			'    def add_payment(self, body):',
			'        self.payments.append(dict(body))',
			'        return len(self.payments)',
			'cp = CpDb()',
			'cp_body = {"amount": 500, "currency": "RUB"}',
			'assert create_payment(cp, {"Idempotency-Key": "k1"}, cp_body) == (201, {"id": 1, "amount": 500})',
			'assert create_payment(cp, {"Idempotency-Key": "k1"}, dict(cp_body)) == (201, {"id": 1, "amount": 500})',
			'assert create_payment(cp, {"Idempotency-Key": "k1"}, {"amount": 500, "currency": "USD"}) == (422, {"error": "key reused"})',
			'assert create_payment(cp, {}, cp_body)[0] == 400',
			'assert len(cp.payments) == 1'
		],
		defects: [
			{
				kind: 'idempotency',
				at: '    saved = db.idem.get(key)',
				text: '    saved = db.idem.get((key, body["amount"]))',
				neighbour: { at: '    if not key:', text: '    if key is None:' }
			},
			{
				kind: 'idempotency',
				at: '        if saved["body"] != body:',
				text: '        if saved["body"]["amount"] != body["amount"]:',
				neighbour: {
					at: '            return 422, {"error": "key reused"}',
					text: '            return 422, {"error": "key reused", "key": key}'
				}
			},
			{
				kind: 'idempotency',
				at: '        return saved["status"], saved["response"]',
				text: '        return 200, saved["response"]',
				neighbour: {
					at: '    response = {"id": payment_id, "amount": body["amount"]}',
					text: '    response = dict(id=payment_id, amount=body["amount"])'
				}
			}
		]
	},
	{
		lines: [
			'def confirm_order(db, order_id):',
			'    """POST /orders/{id}/confirm. Повторный вызов для уже подтверждённого заказа возвращает (200, заказ)',
			'    и не резервирует товар второй раз; неизвестный заказ — (404, {"error": "not found"})."""',
			'    order = db.orders.get(order_id)',
			'    if order is None:',
			'        return 404, {"error": "not found"}',
			'    if order["status"] == "confirmed":',
			'        return 200, order',
			'    db.reserve(order["items"])',
			'    order["status"] = "confirmed"',
			'    return 200, order'
		],
		checks: [
			'class CoDb:',
			'    def __init__(self):',
			'        self.orders = {7: {"id": 7, "items": ["tea"], "status": "new"}}',
			'        self.reserved = []',
			'    def reserve(self, items):',
			'        self.reserved.extend(items)',
			'co = CoDb()',
			'assert confirm_order(co, 7)[0] == 200',
			'assert confirm_order(co, 7) == (200, {"id": 7, "items": ["tea"], "status": "confirmed"})',
			'assert co.reserved == ["tea"] and confirm_order(co, 8)[0] == 404'
		],
		defects: [
			{
				kind: 'idempotency',
				at: '    if order["status"] == "confirmed":',
				text: '    if order.get("confirmed"):',
				neighbour: { at: '    db.reserve(order["items"])', text: '    db.reserve(list(order["items"]))' }
			}
		]
	},
	{
		lines: [
			'def transfer(db, src, dst, amount):',
			'    """POST /transfers. Списание с src и зачисление на dst — одна транзакция: если любая часть упала, не',
			'    меняется ни один счёт и ошибка выходит наружу. Успех — (201, {"from": src, "to": dst, "amount": amount})."""',
			'    tx = db.begin()',
			'    try:',
			'        tx.withdraw(src, amount)',
			'        tx.deposit(dst, amount)',
			'        tx.commit()',
			'    except Exception:',
			'        tx.rollback()',
			'        raise',
			'    return 201, {"from": src, "to": dst, "amount": amount}'
		],
		checks: [
			'class TrDb:',
			'    def __init__(self):',
			'        self.balances = {"a": 100, "b": 0}',
			'    def withdraw(self, acc, amount):',
			'        self.balances[acc] -= amount',
			'    def deposit(self, acc, amount):',
			'        self.balances[acc] += amount',
			'    def begin(self):',
			'        return TrTx(self)',
			'class TrTx:',
			'    def __init__(self, db):',
			'        self.db, self.ops = db, []',
			'    def withdraw(self, acc, amount):',
			'        self.ops.append((acc, -amount))',
			'    def deposit(self, acc, amount):',
			'        if acc not in self.db.balances:',
			'            raise KeyError(acc)',
			'        self.ops.append((acc, amount))',
			'    def commit(self):',
			'        for acc, delta in self.ops:',
			'            self.db.balances[acc] += delta',
			'        self.ops = []',
			'    def rollback(self):',
			'        self.ops = []',
			'tr = TrDb()',
			'assert transfer(tr, "a", "b", 30) == (201, {"from": "a", "to": "b", "amount": 30})',
			...raises('transfer(tr, "a", "zzz", 50)', 'KeyError', 'no error'),
			'assert tr.balances == {"a": 70, "b": 30}'
		],
		defects: [
			{
				kind: 'transaction',
				at: '        tx.withdraw(src, amount)',
				text: '        db.withdraw(src, amount)',
				neighbour: { at: '        tx.deposit(dst, amount)', text: '        tx.deposit(dst, int(amount))' }
			},
			{
				kind: 'transaction',
				at: '        tx.rollback()',
				text: '        tx.commit()',
				neighbour: { at: '        raise', text: '        raise RuntimeError("transfer failed")' }
			}
		]
	},
	{
		lines: [
			'class OutOfStock(Exception):',
			'    pass',
			'',
			'',
			'def place_order(db, user, items):',
			'    """POST /orders. Заказ и резерв товара пишутся в одной транзакции: если резерв не удался (OutOfStock),',
			'    заказа нет — (409, {"error": "out of stock"}). Успех — (201, {"id": номер заказа})."""',
			'    tx = db.begin()',
			'    try:',
			'        order_id = tx.insert_order(user, items)',
			'        tx.reserve(items)',
			'        tx.commit()',
			'    except OutOfStock:',
			'        tx.rollback()',
			'        return 409, {"error": "out of stock"}',
			'    return 201, {"id": order_id}'
		],
		checks: [
			'class PoDb:',
			'    def __init__(self):',
			'        self.orders, self.stock = [], {"tea": 1}',
			'    def insert_order(self, user, items):',
			'        self.orders.append((user, items))',
			'        return len(self.orders)',
			'    def begin(self):',
			'        return PoTx(self)',
			'class PoTx:',
			'    def __init__(self, db):',
			'        self.db, self.new_orders, self.taken = db, [], []',
			'    def insert_order(self, user, items):',
			'        self.new_orders.append((user, items))',
			'        return len(self.db.orders) + len(self.new_orders)',
			'    def reserve(self, items):',
			'        for item in items:',
			'            if self.db.stock.get(item, 0) < 1 + self.taken.count(item):',
			'                raise OutOfStock(item)',
			'            self.taken.append(item)',
			'    def commit(self):',
			'        self.db.orders.extend(self.new_orders)',
			'        for item in self.taken:',
			'            self.db.stock[item] -= 1',
			'        self.new_orders, self.taken = [], []',
			'    def rollback(self):',
			'        self.new_orders, self.taken = [], []',
			'po = PoDb()',
			'assert place_order(po, "ann", ["tea"]) == (201, {"id": 1})',
			'assert place_order(po, "bob", ["tea"]) == (409, {"error": "out of stock"})',
			'assert po.orders == [("ann", ["tea"])] and po.stock == {"tea": 0}'
		],
		defects: [
			{
				kind: 'transaction',
				at: '        order_id = tx.insert_order(user, items)',
				text: '        order_id = db.insert_order(user, items)',
				neighbour: { at: '        tx.reserve(items)', text: '        tx.reserve(list(items))' }
			},
			{
				kind: 'transaction',
				at: '        tx.rollback()',
				text: '        tx.commit()',
				neighbour: {
					at: '        return 409, {"error": "out of stock"}',
					text: '        return 409, {"error": "out of stock", "items": items}'
				}
			}
		]
	},
	{
		lines: [
			'def refund(payments_api, payment_id, amount, refund_no):',
			'    """POST /payments/{id}/refunds. Возврат через payments_api.refund(payment_id, amount, key) с ключом',
			'    идемпотентности f"refund-{payment_id}-{refund_no}"; при TimeoutError — до двух повторов с тем же',
			'    ключом, чтобы возврат не прошёл дважды. Ответ (201, результат)."""',
			'    key = f"refund-{payment_id}-{refund_no}"',
			'    for attempt in range(3):',
			'        try:',
			'            result = payments_api.refund(payment_id, amount, key)',
			'            break',
			'        except TimeoutError:',
			'            if attempt == 2:',
			'                raise',
			'    return 201, result'
		],
		checks: [
			'class RfApi:',
			'    def __init__(self):',
			'        self.done, self.calls = {}, 0',
			'    def refund(self, payment_id, amount, key):',
			'        self.calls += 1',
			'        stored_key = key if key is not None else f"anonymous-{self.calls}"',
			'        self.done.setdefault(stored_key, amount)',
			'        if self.calls == 1:',
			'            raise TimeoutError()',
			'        return {"refunded": sum(self.done.values())}',
			'assert refund(RfApi(), 9, 300, 1) == (201, {"refunded": 300})'
		],
		defects: [
			{
				kind: 'retry-no-key',
				at: '            result = payments_api.refund(payment_id, amount, key)',
				text: '            result = payments_api.refund(payment_id, amount, f"{key}-{attempt}")',
				neighbour: { at: '    return 201, result', text: '    return 201, dict(result)' }
			},
			{
				kind: 'retry-no-key',
				at: '            result = payments_api.refund(payment_id, amount, key)',
				text: '            result = payments_api.refund(payment_id, amount, None)',
				neighbour: { at: '            if attempt == 2:', text: '            if attempt >= 2:' }
			}
		]
	},
	{
		lines: [
			'def notify_shipped(mailer, order):',
			'    """Письмо об отправке: mailer.send(email, template, key) с ключом f"shipped-{id заказа}" — сервис',
			'    писем не отправит дважды письмо с тем же ключом; при TimeoutError — до двух повторов."""',
			'    key = f"shipped-{order[\'id\']}"',
			'    for attempt in range(3):',
			'        try:',
			'            return mailer.send(order["email"], "shipped", key)',
			'        except TimeoutError:',
			'            if attempt == 2:',
			'                raise'
		],
		checks: [
			'class NsMailer:',
			'    def __init__(self):',
			'        self.sent, self.calls = {}, 0',
			'    def send(self, email, template, key):',
			'        self.calls += 1',
			'        self.sent.setdefault(key, email)',
			'        if self.calls == 1:',
			'            raise TimeoutError()',
			'        return len(self.sent)',
			'assert notify_shipped(NsMailer(), {"id": 4, "email": "a@x.ru"}) == 1'
		],
		defects: [
			{
				kind: 'retry-no-key',
				at: '            return mailer.send(order["email"], "shipped", key)',
				text: '            return mailer.send(order["email"], "shipped", key + str(attempt))',
				neighbour: { at: '    key = f"shipped-{order[\'id\']}"', text: '    key = "shipped-" + str(order["id"])' }
			}
		]
	}
];

const MIDDLE_X: Unit[] = [
	{
		lines: [
			'def update_doc(db, doc_id, headers, body):',
			'    """PUT /docs/{id}. Заголовок If-Match с версией обязателен (иначе 428) и должен совпасть с текущей',
			'    версией документа (иначе 412, документ не меняется). Успех — версия + 1, ответ (200, документ);',
			'    нет документа — 404."""',
			'    doc = db.docs.get(doc_id)',
			'    if doc is None:',
			'        return 404, {"error": "not found"}',
			'    expected = headers.get("If-Match")',
			'    if expected is None:',
			'        return 428, {"error": "precondition required"}',
			'    if int(expected) != doc["version"]:',
			'        return 412, {"error": "version mismatch"}',
			'    db.docs[doc_id] = {"text": body["text"], "version": doc["version"] + 1}',
			'    return 200, db.docs[doc_id]'
		],
		checks: [
			'class UdDb:',
			'    def __init__(self):',
			'        self.docs = {1: {"text": "v1", "version": 3}}',
			'ud = UdDb()',
			'assert update_doc(ud, 1, {"If-Match": "2"}, {"text": "old"}) == (412, {"error": "version mismatch"})',
			'assert update_doc(ud, 1, {}, {"text": "blind"}) == (428, {"error": "precondition required"})',
			'assert update_doc(ud, 1, {"If-Match": "3"}, {"text": "v2"}) == (200, {"text": "v2", "version": 4})',
			'assert update_doc(ud, 1, {"If-Match": "3"}, {"text": "late"})[0] == 412 and ud.docs[1]["text"] == "v2"',
			'assert update_doc(ud, 5, {"If-Match": "1"}, {"text": "x"})[0] == 404'
		],
		defects: [
			{
				kind: 'precondition',
				at: '    if int(expected) != doc["version"]:',
				text: '    if int(expected) > doc["version"]:',
				neighbour: { at: '    doc = db.docs.get(doc_id)', text: '    doc = db.docs.get(int(doc_id))' }
			},
			{
				kind: 'precondition',
				at: '    expected = headers.get("If-Match")',
				text: '    expected = headers.get("If-Match", doc["version"])',
				neighbour: {
					at: '        return 428, {"error": "precondition required"}',
					text: '        return 428, {"error": "If-Match required"}'
				}
			},
			{
				kind: 'precondition',
				at: '        return 412, {"error": "version mismatch"}',
				text: '        return 409, {"error": "version mismatch"}',
				neighbour: { at: '    return 200, db.docs[doc_id]', text: '    return 200, dict(db.docs[doc_id])' }
			}
		]
	},
	{
		lines: [
			'def get_catalog(db, headers):',
			'    """GET /catalog. Ответ (200, {"etag": ETag, "items": товары}); ETag — ревизия каталога в кавычках:',
			'    "rev-<номер>". Если If-None-Match совпадает с текущим ETag — (304, None), без тела."""',
			'    etag = f\'"rev-{db.revision}"\'',
			'    if headers.get("If-None-Match") == etag:',
			'        return 304, None',
			'    return 200, {"etag": etag, "items": list(db.items)}'
		],
		checks: [
			'class GcDb:',
			'    def __init__(self):',
			'        self.revision, self.items = 12, ["tea"]',
			'gc = GcDb()',
			'gc_first = get_catalog(gc, {})',
			'assert gc_first == (200, {"etag": \'"rev-12"\', "items": ["tea"]})',
			'assert get_catalog(gc, {"If-None-Match": gc_first[1]["etag"]}) == (304, None)',
			'gc.revision = 13',
			'assert get_catalog(gc, {"If-None-Match": \'"rev-12"\'})[0] == 200'
		],
		defects: [
			{
				kind: 'precondition',
				at: '    etag = f\'"rev-{db.revision}"\'',
				text: '    etag = f"rev-{db.revision}"',
				neighbour: {
					at: '    return 200, {"etag": etag, "items": list(db.items)}',
					text: '    return 200, {"etag": etag, "items": db.items[:]}'
				}
			},
			{
				kind: 'precondition',
				at: '        return 304, None',
				text: '        return 304, {"items": list(db.items)}',
				neighbour: {
					at: '    if headers.get("If-None-Match") == etag:',
					text: '    if headers.get("If-None-Match", "") == etag:'
				}
			}
		]
	}
];

const MODULE_TITLES = [
	'Обработчики HTTP сервиса заказов',
	'Обработчики API платежей',
	'Ручки API каталога и профилей',
	'Обработчики REST API магазина'
];
const OPTIONAL_IMPORTS = ['import logging', 'import json', 'import uuid'];
const HEADER_CONSTANTS = [
	'API_VERSION = "v1"',
	'DEFAULT_PAGE_SIZE = 20',
	'MAX_PAGE_SIZE = 100',
	'SERVICE = "shop-api"',
	'RATE_LIMIT_PER_MIN = 3',
	'LOG = logging.getLogger(__name__)'
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
	const constants = rng.sample(
		HEADER_CONSTANTS.filter((c) => imports.includes('import logging') || !c.includes('logging')),
		rng.int(0, 4)
	);
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		...(imports.length ? ['', ...imports.sort()] : []),
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
	const reserve = cls.form === 'X';
	const p =
		input.grade === 'junior'
			? compose(rng, reserve ? [...JUNIOR, ...JUNIOR_X] : JUNIOR, input.classId, 4)
			: compose(rng, reserve ? [...MIDDLE, ...MIDDLE_X] : MIDDLE, input.classId, 3);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль обработчиков HTTP на Python 3. Обработчик получает части запроса и хранилища параметрами и ' +
				'возвращает пару (код ответа, тело). У каждого обработчика в строке документации записан его контракт. ' +
				'Ровно одна строка модуля нарушает контракт своего обработчика: если заменить только её, все обработчики ' +
				'будут работать по контракту. Введите номер этой строки (нумерация с 1).',
			code: { language: 'python3', source: p.source }
		},
		answer: { kind: 'line_no', value: p.answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'bug', check: p.check, fix: p.fix }),
		wrong: () => ({
			'neighbour-line': { kind: 'line', line: p.neighbour.line, replacement: p.neighbour.text },
			'other-handler': p.other.line === 0 ? null : { kind: 'line', line: p.other.line, replacement: p.other.text }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
