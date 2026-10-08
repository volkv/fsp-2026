// A Kotlin module of models, caches and stores, each unit with its specification in KDoc; exactly one line breaks its
// unit's specification, and the defect is one of equality and identity: a mutable key of a hash collection, `===`
// where values are compared (boxed numbers outside the cache -128..127, strings built at run time), `equals` without
// a matching `hashCode`, a copy that shares a mutable collection (middle); internal state that leaks out, an ordering
// or a uniqueness key that ignores the tie rule, a key mutated inside a hash collection, identity of boxed values in a
// cache — each showing only in a combination of operations (senior). The candidate names that line. The kind of the
// defect is the essential class; the other units, their order and the header are surface.
import {
	instanceRng,
	levelAndClass,
	readDescriptor,
	type Built,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { composeDefect, defectBuilt, type KtUnit } from '../../_lib/kotlin-items.ts';

const descriptor = readDescriptor(import.meta.url);

const TYPES: Readonly<Record<string, string>> = {
	Query: 'data class Query(var text: String, var page: Int)',
	Filter: 'data class Filter(var name: String, var value: String)',
	Message: 'data class Message(val id: Int, val authorId: Int?)',
	Cart: 'data class Cart(val owner: String, val items: MutableList<String>)',
	Player: 'data class Player(val id: Int, val score: Int)',
	Contact: 'data class Contact(val name: String, val phone: String)',
	Pin: 'data class Pin(var lat: Int, var lng: Int)',
	Room: 'data class Room(val id: Int, var title: String)',
	Stat: 'data class Stat(val id: Int, val count: Int)',
	Draft: 'data class Draft(val chatId: Int, var text: String)'
};

const HEADER = {
	titles: [
		'Модели и кэши экрана поиска',
		'Хранилища состояния приложения',
		'Слой данных чата',
		'Модели корзины и каталога'
	],
	constants: [
		'const val CACHE_SIZE = 64',
		'const val PAGE_SIZE = 20',
		'const val SYNC_INTERVAL_MS = 30_000',
		'const val MAX_HISTORY = 10',
		'const val DEFAULT_ROOM = "general"'
	]
};

const kdoc = (...text: string[]): string[] => ['/**', ...text.map((t) => ` * ${t}`), ' */'];

/** The index of the line that is `text` (trimmed), or else the only line containing it. */
function locate(lines: readonly string[], text: string): number {
	const exact = lines.flatMap((l, i) => (l.trim() === text ? [i] : []));
	if (exact.length === 1) return exact[0] as number;
	const partial = lines.flatMap((l, i) => (l.includes(text) ? [i] : []));
	if (partial.length !== 1) throw new Error(`«${text}» matches ${partial.length} lines`);
	return partial[0] as number;
}

interface UnitSpec {
	name: string;
	needs?: string[];
	lines: string[];
	checks: string[];
	kind: string;
	/** The defect: the line (by its text) and the defective text. */
	defect: [at: string, text: string];
	/** The neighbour edit in the same unit that leaves the defect in place. */
	neighbour: [at: string, text: string];
	/** The edit of this unit when it is a correct unit of the module. */
	decoy: [at: string, text: string];
}

function unit(spec: UnitSpec): KtUnit {
	const at = (text: string): number => locate(spec.lines, text);
	return {
		name: spec.name,
		needs: spec.needs ?? [],
		lines: spec.lines,
		checks: spec.checks,
		defects: [
			{
				kind: spec.kind,
				line: at(spec.defect[0]),
				text: spec.defect[1],
				neighbour: { line: at(spec.neighbour[0]), text: spec.neighbour[1] }
			}
		],
		decoy: { line: at(spec.decoy[0]), text: spec.decoy[1] }
	};
}

const MIDDLE: KtUnit[] = [
	unit({
		name: 'SearchCache',
		needs: ['Query'],
		kind: 'mutable-key',
		lines: [
			...kdoc(
				'Кэш результатов поиска. nextPage(q) возвращает новый запрос на следующую страницу и не меняет q:',
				'q остаётся ключом своих результатов.'
			),
			'class SearchCache {',
			'    private val results = HashMap<Query, List<String>>()',
			'',
			'    fun put(q: Query, items: List<String>) {',
			'        results[q] = items',
			'    }',
			'',
			'    fun get(q: Query): List<String>? = results[q]',
			'',
			'    fun nextPage(q: Query): Query = q.copy(page = q.page + 1)',
			'}'
		],
		checks: [
			'val c = SearchCache()',
			'val q = Query("kotlin", 1)',
			'c.put(q, listOf("a"))',
			'val n = c.nextPage(q)',
			'check(n.page == 2 && q.page == 1)',
			'check(c.get(Query("kotlin", 1)) == listOf("a"))'
		],
		defect: ['fun nextPage', '    fun nextPage(q: Query): Query = q.apply { page += 1 }'],
		neighbour: ['results[q] = items', '        results.put(q, items)'],
		decoy: ['fun get(q: Query)', '    fun get(q: Query): List<String>? = results[q.copy()]']
	}),
	unit({
		name: 'FilterSet',
		needs: ['Filter'],
		kind: 'mutable-key',
		lines: [
			...kdoc(
				'Выбранные фильтры. rename(f, v) заменяет выбранный фильтр f фильтром с тем же именем и значением v',
				'(такой фильтр ещё не выбран): старый больше не выбран, новый выбран, число фильтров не меняется.'
			),
			'class FilterSet {',
			'    private val selected = HashSet<Filter>()',
			'',
			'    fun add(f: Filter): Boolean = selected.add(f)',
			'',
			'    fun contains(f: Filter): Boolean = f in selected',
			'',
			'    fun size(): Int = selected.size',
			'',
			'    fun rename(f: Filter, v: String) {',
			'        selected.remove(f)',
			'        selected.add(f.copy(value = v))',
			'    }',
			'}'
		],
		checks: [
			'val s = FilterSet()',
			'val f = Filter("color", "red")',
			's.add(f)',
			's.rename(f, "blue")',
			'check(s.size() == 1)',
			'check(!s.contains(Filter("color", "red")))',
			'check(s.contains(Filter("color", "blue")))'
		],
		defect: ['selected.remove(f)', '        f.value = v'],
		neighbour: ['selected.add(f.copy(value = v))', '        selected += f.copy(value = v)'],
		decoy: ['fun contains', '    fun contains(f: Filter): Boolean = selected.contains(f)']
	}),
	unit({
		name: 'sameAuthor',
		needs: ['Message'],
		kind: 'identity-equality',
		lines: [
			...kdoc('Одного ли автора сообщения: authorId обоих известен (не null) и совпадает.'),
			'fun sameAuthor(a: Message, b: Message): Boolean {',
			'    if (a.authorId == null) return false',
			'    return a.authorId == b.authorId',
			'}'
		],
		checks: [
			'check(sameAuthor(Message(1, 500 * 2), Message(2, 1000)))',
			'check(sameAuthor(Message(3, 7), Message(4, 7)))',
			'check(!sameAuthor(Message(5, null), Message(6, null)))',
			'check(!sameAuthor(Message(7, 1), Message(8, null)))'
		],
		defect: ['return a.authorId == b.authorId', '    return a.authorId === b.authorId'],
		neighbour: ['if (a.authorId == null) return false', '    if (null == a.authorId) return false'],
		decoy: ['if (a.authorId == null) return false', '    if (a.authorId == null && b.authorId == null) return false']
	}),
	unit({
		name: 'Navigator',
		kind: 'identity-equality',
		lines: [
			...kdoc(
				'Навигатор. open(section, id) открывает экран «section/id»; isOpen(route) — открыт ли экран',
				'с таким маршрутом (маршруты сравниваются как строки, по содержимому).'
			),
			'class Navigator {',
			'    private var current = "home"',
			'',
			'    fun open(section: String, id: Int) {',
			'        current = "$section/$id"',
			'    }',
			'',
			'    fun isOpen(route: String): Boolean = current == route',
			'}'
		],
		checks: [
			'val n = Navigator()',
			'check(n.isOpen("home"))',
			'n.open("chat", 5)',
			'check(n.isOpen("chat/5"))',
			'check(!n.isOpen("chat/6"))'
		],
		defect: ['fun isOpen', '    fun isOpen(route: String): Boolean = current === route'],
		neighbour: ['current = "$section/$id"', '        current = section + "/" + id'],
		decoy: ['private var current', '    private var current: String = "home"']
	}),
	unit({
		name: 'Tag',
		kind: 'equals-hashcode',
		lines: [
			...kdoc(
				'Тег поиска. Теги равны без учёта регистра: совпадают имена, приведённые lowercase();',
				'их хранят в HashSet и используют как ключи HashMap.'
			),
			'class Tag(val name: String) {',
			'    override fun equals(other: Any?): Boolean = other is Tag && other.name.lowercase() == name.lowercase()',
			'',
			'    override fun hashCode(): Int = name.lowercase().hashCode()',
			'}'
		],
		checks: [
			'check(Tag("Kotlin") == Tag("kotlin"))',
			'check(hashSetOf(Tag("Kotlin"), Tag("kotlin"), Tag("Java")).size == 2)'
		],
		defect: ['override fun hashCode', '    override fun hashCode(): Int = name.hashCode()'],
		neighbour: [
			'override fun equals',
			'    override fun equals(other: Any?): Boolean = other is Tag && other.name.equals(name, ignoreCase = true)'
		],
		decoy: ['override fun hashCode', '    override fun hashCode(): Int = name.uppercase().hashCode()']
	}),
	unit({
		name: 'CartLine',
		kind: 'equals-hashcode',
		lines: [
			...kdoc(
				'Позиция корзины. Позиции с одинаковым sku равны (количество не важно):',
				'distinct() оставляет по одной позиции на sku.'
			),
			'class CartLine(val sku: String, val qty: Int) {',
			'    override fun equals(other: Any?): Boolean = other is CartLine && other.sku == sku',
			'',
			'    override fun hashCode(): Int = sku.hashCode()',
			'}'
		],
		checks: [
			'val lines = listOf(CartLine("tea", 1), CartLine("tea", 3), CartLine("cake", 1))',
			'check(lines.distinct().size == 2)',
			'check(CartLine("tea", 1) == CartLine("tea", 2))'
		],
		defect: ['override fun hashCode', '    override fun hashCode(): Int = 31 * sku.hashCode() + qty'],
		neighbour: [
			'override fun equals',
			'    override fun equals(other: Any?): Boolean = (other as? CartLine)?.sku == sku'
		],
		decoy: ['override fun hashCode', '    override fun hashCode(): Int = sku.length']
	}),
	unit({
		name: 'withItem',
		needs: ['Cart'],
		kind: 'shared-mutable',
		lines: [
			...kdoc('Новая корзина: копия cart с товаром item в конце; исходная корзина не меняется.'),
			'fun withItem(cart: Cart, item: String): Cart {',
			'    val copy = cart.copy(items = cart.items.toMutableList())',
			'    copy.items.add(item)',
			'    return copy',
			'}'
		],
		checks: [
			'val c = Cart("ann", mutableListOf("tea"))',
			'val d = withItem(c, "cake")',
			'check(d.items == listOf("tea", "cake"))',
			'check(c.items == listOf("tea"))'
		],
		defect: ['val copy', '    val copy = cart.copy()'],
		neighbour: ['copy.items.add(item)', '    copy.items += item'],
		decoy: ['val copy', '    val copy = cart.copy(items = ArrayList(cart.items))']
	}),
	unit({
		name: 'SearchHistory',
		kind: 'shared-mutable',
		lines: [
			...kdoc(
				'История поиска: не больше limit последних запросов. snapshot() — копия:',
				'её изменения историю не трогают.'
			),
			'class SearchHistory(private val limit: Int) {',
			'    private val items = mutableListOf<String>()',
			'',
			'    fun add(query: String) {',
			'        items.add(query)',
			'        if (items.size > limit) items.removeAt(0)',
			'    }',
			'',
			'    fun snapshot(): MutableList<String> = items.toMutableList()',
			'}'
		],
		checks: [
			'val h = SearchHistory(2)',
			'h.add("a")',
			'h.add("b")',
			'h.add("c")',
			'val s = h.snapshot()',
			's.clear()',
			'check(h.snapshot() == listOf("b", "c"))'
		],
		defect: ['fun snapshot', '    fun snapshot(): MutableList<String> = items'],
		neighbour: ['if (items.size > limit)', '        while (items.size > limit) items.removeAt(0)'],
		decoy: ['items.add(query)', '        items += query']
	})
];

const SENIOR: KtUnit[] = [
	unit({
		name: 'leaderboard',
		needs: ['Player'],
		kind: 'ordering-key',
		lines: [
			...kdoc('Таблица лидеров: id первых top игроков по убыванию score, при равном score — по возрастанию id.'),
			'fun leaderboard(players: List<Player>, top: Int): List<Int> {',
			'    val ordered = players.sortedWith(compareByDescending<Player> { it.score }.thenBy { it.id })',
			'    return ordered.take(top).map { it.id }',
			'}'
		],
		checks: [
			'check(leaderboard(listOf(Player(1, 10), Player(2, 10), Player(3, 7)), 2) == listOf(1, 2))',
			'check(leaderboard(listOf(Player(4, 10), Player(1, 10), Player(2, 12)), 3) == listOf(2, 1, 4))'
		],
		defect: ['val ordered', '    val ordered = players.sortedByDescending { it.score }'],
		neighbour: ['return ordered', '    return ordered.map { it.id }.take(top)'],
		decoy: ['return ordered', '    return ordered.map { it.id }.take(top)']
	}),
	unit({
		name: 'shareTargets',
		needs: ['Contact'],
		kind: 'ordering-key',
		lines: [
			...kdoc(
				'Получатели «Поделиться»: имена контактов, по одному на номер телефона (первый встретившийся),',
				'в порядке первого появления.'
			),
			'fun shareTargets(contacts: List<Contact>): List<String> {',
			'    val unique = contacts.distinctBy { it.phone }',
			'    return unique.map { it.name }',
			'}'
		],
		checks: [
			'val cs = listOf(Contact("Ann", "1"), Contact("Bob", "2"), Contact("Annie", "1"), Contact("Bob", "3"))',
			'check(shareTargets(cs) == listOf("Ann", "Bob", "Bob"))',
			'check(shareTargets(listOf(Contact("Ann", "1"), Contact("Ann", "1"))) == listOf("Ann"))'
		],
		defect: ['val unique', '    val unique = contacts.distinctBy { it.name }'],
		neighbour: ['return unique', '    return unique.map(Contact::name)'],
		decoy: ['val unique', '    val unique = contacts.distinct()']
	}),
	unit({
		name: 'mostActive',
		needs: ['Stat'],
		kind: 'ordering-key',
		lines: [
			...kdoc('Самый активный пользователь: id с наибольшим count, при равенстве — меньший id; пустой список — null.'),
			'fun mostActive(stats: List<Stat>): Int? {',
			'    val best = stats.minWithOrNull(compareByDescending<Stat> { it.count }.thenBy { it.id })',
			'    return best?.id',
			'}'
		],
		checks: [
			'check(mostActive(listOf(Stat(2, 5), Stat(7, 9))) == 7)',
			'check(mostActive(listOf(Stat(5, 3), Stat(2, 3), Stat(9, 1))) == 2)',
			'check(mostActive(emptyList()) == null)'
		],
		defect: ['val best', '    val best = stats.maxByOrNull { it.count }'],
		neighbour: ['return best?.id', '    return best?.let { it.id }'],
		decoy: ['return best?.id', '    return best?.let { it.id }']
	}),
	unit({
		name: 'CartStore',
		kind: 'exposed-state',
		lines: [
			...kdoc('Корзина. items() — снимок позиций на момент вызова: последующие add() его не меняют.'),
			'class CartStore {',
			'    private val lines = mutableListOf<String>()',
			'',
			'    fun add(sku: String) {',
			'        lines.add(sku)',
			'    }',
			'',
			'    fun items(): List<String> = lines.toList()',
			'}'
		],
		checks: [
			'val c = CartStore()',
			'c.add("tea")',
			'val snap = c.items()',
			'c.add("cake")',
			'check(snap == listOf("tea"))',
			'check(c.items() == listOf("tea", "cake"))'
		],
		defect: ['fun items', '    fun items(): List<String> = lines'],
		neighbour: ['lines.add(sku)', '        lines += sku'],
		decoy: ['fun items', '    fun items(): List<String> = lines.toMutableList()']
	}),
	unit({
		name: 'dropMuted',
		needs: ['Room'],
		kind: 'exposed-state',
		lines: [
			...kdoc(
				'Убирает из списка чатов chats заглушённые (id из muted) прямо в переданном списке;',
				'порядок остальных сохраняется.'
			),
			'fun dropMuted(chats: MutableList<Room>, muted: Set<Int>) {',
			'    for (room in chats.toList()) {',
			'        if (room.id in muted) chats.remove(room)',
			'    }',
			'}'
		],
		checks: [
			'val chats = mutableListOf(Room(1, "a"), Room(2, "b"), Room(3, "c"), Room(4, "d"))',
			'dropMuted(chats, setOf(1, 3))',
			'check(chats.map { it.id } == listOf(2, 4))',
			'val one = mutableListOf(Room(5, "e"))',
			'dropMuted(one, setOf(5))',
			'check(one.isEmpty())'
		],
		defect: ['for (room in chats', '    for (room in chats) {'],
		neighbour: ['if (room.id in muted)', '        if (muted.contains(room.id)) chats.remove(room)'],
		decoy: ['if (room.id in muted)', '        if (muted.contains(room.id)) chats.remove(room)']
	}),
	unit({
		name: 'DraftBox',
		needs: ['Draft'],
		kind: 'exposed-state',
		lines: [
			...kdoc(
				'Черновики по чатам, один на чат. save() сохраняет копию: последующие изменения',
				'переданного объекта сохранённый черновик не меняют.'
			),
			'class DraftBox {',
			'    private val drafts = LinkedHashMap<Int, Draft>()',
			'',
			'    fun save(draft: Draft) {',
			'        drafts[draft.chatId] = draft.copy()',
			'    }',
			'',
			'    fun text(chatId: Int): String? = drafts[chatId]?.text',
			'}'
		],
		checks: [
			'val box = DraftBox()',
			'val d = Draft(1, "При")',
			'box.save(d)',
			'd.text = "Привет"',
			'check(box.text(1) == "При")',
			'box.save(d)',
			'check(box.text(1) == "Привет")'
		],
		defect: ['drafts[draft.chatId]', '        drafts[draft.chatId] = draft'],
		neighbour: ['fun text', '    fun text(chatId: Int): String? = drafts.get(chatId)?.text'],
		decoy: ['fun text', '    fun text(chatId: Int): String? = drafts.get(chatId)?.text']
	}),
	unit({
		name: 'PinLayer',
		needs: ['Pin'],
		kind: 'mutated-key',
		lines: [
			...kdoc(
				'Слой меток карты. move(pin, lat, lng) переносит метку слоя: после переноса она находится по новым',
				'координатам, remove(pin) её удаляет, меток не становится больше; метку не из слоя move не трогает.'
			),
			'class PinLayer {',
			'    private val pins = HashSet<Pin>()',
			'',
			'    fun add(pin: Pin): Boolean = pins.add(pin)',
			'',
			'    fun move(pin: Pin, lat: Int, lng: Int) {',
			'        if (!pins.remove(pin)) return',
			'        pin.lat = lat',
			'        pin.lng = lng',
			'        pins.add(pin)',
			'    }',
			'',
			'    fun has(pin: Pin): Boolean = pin in pins',
			'',
			'    fun remove(pin: Pin): Boolean = pins.remove(pin)',
			'',
			'    fun size(): Int = pins.size',
			'}'
		],
		checks: [
			'val layer = PinLayer()',
			'val p = Pin(1, 2)',
			'layer.add(p)',
			'layer.move(p, 5, 6)',
			'check(layer.has(Pin(5, 6)))',
			'check(layer.size() == 1)',
			'layer.remove(p)',
			'check(layer.size() == 0)',
			'val q = Pin(3, 4)',
			'layer.move(q, 7, 8)',
			'check(q == Pin(3, 4) && layer.size() == 0)'
		],
		defect: ['if (!pins.remove(pin)) return', '        if (pin !in pins) return'],
		neighbour: ['pins.add(pin)', '        pins += pin'],
		decoy: ['fun has', '    fun has(pin: Pin): Boolean = pins.contains(pin)']
	}),
	unit({
		name: 'UnreadCounter',
		needs: ['Room'],
		kind: 'mutated-key',
		lines: [
			...kdoc(
				'Непрочитанные по комнатам, одна запись на комнату. rename() меняет название комнаты,',
				'её счётчик сохраняется.'
			),
			'class UnreadCounter {',
			'    private val counts = HashMap<Room, Int>()',
			'',
			'    fun inc(room: Room) {',
			'        counts[room] = (counts[room] ?: 0) + 1',
			'    }',
			'',
			'    fun rename(room: Room, title: String) {',
			'        val n = counts.remove(room) ?: 0',
			'        room.title = title',
			'        counts[room] = n',
			'    }',
			'',
			'    fun count(room: Room): Int = counts[room] ?: 0',
			'',
			'    fun rooms(): Int = counts.size',
			'}'
		],
		checks: [
			'val u = UnreadCounter()',
			'val r = Room(1, "general")',
			'u.inc(r)',
			'u.inc(r)',
			'u.rename(r, "team")',
			'check(u.count(r) == 2)',
			'check(u.rooms() == 1)'
		],
		defect: ['val n = counts.remove', '        val n = counts[room] ?: 0'],
		neighbour: ['counts[room] = n', '        counts.put(room, n)'],
		decoy: ['fun count(', '    fun count(room: Room): Int = counts.getOrDefault(room, 0)']
	}),
	unit({
		name: 'VersionCache',
		kind: 'boxed-identity',
		lines: [
			...kdoc(
				'Кэш версий профилей. changed(id, version) — true, если версия отличается от запомненной',
				'(сравниваются числа) или её ещё нет; запоминает новую версию.'
			),
			'class VersionCache {',
			'    private val versions = HashMap<Int, Int>()',
			'',
			'    fun changed(id: Int, version: Int): Boolean {',
			'        val old = versions[id]',
			'        versions[id] = version',
			'        return old != version',
			'    }',
			'}'
		],
		checks: [
			'val c = VersionCache()',
			'check(c.changed(1, 5))',
			'check(!c.changed(1, 5))',
			'check(c.changed(1, 1000))',
			'check(!c.changed(1, 1000))'
		],
		defect: ['return old != version', '        return old !== version'],
		neighbour: ['versions[id] = version', '        versions.put(id, version)'],
		decoy: ['val old = versions[id]', '        val old: Int? = versions[id]']
	}),
	unit({
		name: 'Favorites',
		kind: 'boxed-identity',
		lines: [
			...kdoc(
				'Избранные экраны. isFavorite(route) — есть ли маршрут в избранном (строки сравниваются по содержимому).'
			),
			'class Favorites {',
			'    private val routes = mutableListOf<String>()',
			'',
			'    fun add(section: String, id: Int) {',
			'        routes.add("$section/$id")',
			'    }',
			'',
			'    fun isFavorite(route: String): Boolean = routes.any { it == route }',
			'}'
		],
		checks: [
			'val f = Favorites()',
			'f.add("chat", 7)',
			'check(f.isFavorite("chat/7"))',
			'check(!f.isFavorite("chat/8"))'
		],
		defect: ['fun isFavorite', '    fun isFavorite(route: String): Boolean = routes.any { it === route }'],
		neighbour: ['routes.add(', '        routes += "$section/$id"'],
		decoy: ['fun isFavorite', '    fun isFavorite(route: String): Boolean = route in routes']
	}),
	unit({
		name: 'PriceWatcher',
		kind: 'boxed-identity',
		lines: [
			...kdoc(
				'Наблюдатель цен. update(sku, price) — true, если цена товара изменилась с прошлого вызова',
				'или это первый вызов для товара; цены сравниваются как числа.'
			),
			'class PriceWatcher {',
			'    private val last = HashMap<String, Long>()',
			'',
			'    fun update(sku: String, price: Long): Boolean {',
			'        val prev = last.put(sku, price)',
			'        return prev != price',
			'    }',
			'}'
		],
		checks: [
			'val w = PriceWatcher()',
			'check(w.update("tea", 100))',
			'check(!w.update("tea", 100))',
			'check(w.update("tea", 5000))',
			'check(!w.update("tea", 5000))'
		],
		defect: ['return prev != price', '        return prev !== price'],
		neighbour: ['val prev', '        val prev: Long? = last.put(sku, price)'],
		decoy: ['val prev', '        val prev = last.get(sku).also { last[sku] = price }']
	})
];

const MARKDOWN =
	'Модуль моделей и хранилищ на Kotlin 2.4 (Kotlin/JVM, JVM 21 с настройками по умолчанию). У каждой функции и класса ' +
	'в KDoc-комментарии записана спецификация. Ровно одна строка модуля нарушает спецификацию своей функции или класса. ' +
	'Введите номер этой строки (нумерация с 1). Если исправить можно в нескольких строках — засчитывается любая из них, ' +
	'где замена одной инструкцией восстанавливает спецификацию. Исправление — одна простая инструкция того же вида, что ' +
	'исправляемая строка: не добавляйте конструкций, которых в ней нет (новые лямбды, `?.let`/`?:`-цепочки, ' +
	'`if`-выражения, обёртки, новые функции), и не переносите в неё логику из другой строки.';

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const library = input.grade === 'middle' ? MIDDLE : SENIOR;
	const module = composeDefect(rng, library, input.classId, 3, TYPES, HEADER);
	return defectBuilt(descriptor, input, module, MARKDOWN);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
