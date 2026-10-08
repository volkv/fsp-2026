// A Kotlin module of screen and repository functions, each with its specification in KDoc; exactly one line breaks
// its unit's specification. The candidate names that line. The kind of the defect is the essential class: a missing
// default for null, the precedence of the elvis operator, a range boundary, the wrong lookup function (intern); a
// `lateinit` property where reading it before initialization is allowed, `orEmpty` erasing the difference between
// null and empty, a property read again after it changed, a view used after the screen was destroyed (junior). The
// other units, their order and the header are surface.
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
	User: 'data class User(val id: Int, val name: String?, val nickname: String?)',
	Message: 'data class Message(val id: Int, val text: String?, val author: User?)',
	Screen: 'data class Screen(val route: String, val title: String?)',
	Order: 'data class Order(val id: Int, val total: Int?, val coupon: String?)'
};

const HEADER = {
	titles: [
		'Функции экрана профиля',
		'Помощники списка сообщений',
		'Функции экрана заказа',
		'Общие функции экранов',
		'Утилиты слоя представления'
	],
	constants: [
		'const val PAGE_SIZE = 20',
		'const val MAX_TITLE = 40',
		'const val DEFAULT_ROUTE = "home"',
		'const val RETRY_LIMIT = 3',
		'const val ANIMATION_MS = 300'
	]
};

const kdoc = (...text: string[]): string[] => ['/**', ...text.map((t) => ` * ${t}`), ' */'];

const INTERN: KtUnit[] = [
	{
		name: 'screenTitle',
		needs: ['Screen'],
		lines: [
			...kdoc('Заголовок экрана: title, а если его нет (null) — route.'),
			'fun screenTitle(screen: Screen): String {',
			'    return screen.title ?: screen.route',
			'}'
		],
		checks: [
			'check(screenTitle(Screen("home", null)) == "home")',
			'check(screenTitle(Screen("cart", "Корзина")) == "Корзина")'
		],
		defects: [
			{
				kind: 'missing-default',
				line: 4,
				text: '    return screen.title!!',
				neighbour: { line: 3, text: 'fun screenTitle(screen: Screen): String? {' }
			}
		],
		decoy: { line: 4, text: '    return screen.title!!' }
	},
	{
		name: 'displayName',
		needs: ['User'],
		lines: [
			...kdoc('Имя в списке: никнейм с «@»; без никнейма (null) — name; если нет и его — «Гость».'),
			'fun displayName(user: User): String {',
			'    val nick = user.nickname ?: return user.name ?: "Гость"',
			'    return "@$nick"',
			'}'
		],
		checks: [
			'check(displayName(User(1, "Анна", null)) == "Анна")',
			'check(displayName(User(2, null, "ann")) == "@ann")',
			'check(displayName(User(3, null, null)) == "Гость")'
		],
		defects: [
			{
				kind: 'missing-default',
				line: 4,
				text: '    val nick = user.nickname ?: return user.name!!',
				neighbour: { line: 5, text: '    return "@" + nick' }
			}
		],
		decoy: { line: 4, text: '    val nick = user.nickname ?: return user.name.orEmpty()' }
	},
	{
		name: 'couponLabel',
		needs: ['Order'],
		lines: [
			...kdoc('Текст купона: «Купон CODE» или «Без купона», если купона нет (null).'),
			'fun couponLabel(order: Order): String {',
			'    val code = order.coupon ?: return "Без купона"',
			'    return "Купон $code"',
			'}'
		],
		checks: [
			'check(couponLabel(Order(1, 10, "SALE")) == "Купон SALE")',
			'check(couponLabel(Order(2, 10, null)) == "Без купона")'
		],
		defects: [
			{
				kind: 'missing-default',
				line: 4,
				text: '    val code = order.coupon.toString()',
				neighbour: { line: 5, text: '    return "Купон " + code' }
			}
		],
		decoy: { line: 4, text: '    val code = order.coupon.toString()' }
	},
	{
		name: 'authorName',
		needs: ['Message', 'User'],
		lines: [
			...kdoc('Имя автора сообщения; если автора нет или у него нет имени — «аноним».'),
			'fun authorName(message: Message): String {',
			'    return message.author?.name ?: "аноним"',
			'}'
		],
		checks: [
			'check(authorName(Message(1, "a", User(1, "Ия", null))) == "Ия")',
			'check(authorName(Message(2, "b", null)) == "аноним")',
			'check(authorName(Message(3, "c", User(2, null, null))) == "аноним")'
		],
		defects: [
			{
				kind: 'missing-default',
				line: 4,
				text: '    return message.author!!.name ?: "аноним"',
				neighbour: { line: 3, text: 'fun authorName(message: Message): String? {' }
			}
		],
		decoy: { line: 4, text: '    return message.author!!.name ?: "аноним"' }
	},
	{
		name: 'badgeCount',
		lines: [
			...kdoc('Число на бейдже: непрочитанные unread (null — 0) плюс ожидающие отправки pending.'),
			'fun badgeCount(unread: Int?, pending: Int): Int {',
			'    return (unread ?: 0) + pending',
			'}'
		],
		checks: ['check(badgeCount(null, 2) == 2)', 'check(badgeCount(3, 2) == 5)'],
		defects: [
			{
				kind: 'elvis-precedence',
				line: 4,
				text: '    return unread ?: 0 + pending',
				neighbour: { line: 3, text: 'fun badgeCount(unread: Int?, pending: Int = 0): Int {' }
			}
		],
		decoy: { line: 4, text: '    return unread ?: 0 + pending' }
	},
	{
		name: 'amountDue',
		needs: ['Order'],
		lines: [
			...kdoc('Сумма к оплате: total заказа (null — 0) плюс доставка delivery.'),
			'fun amountDue(order: Order, delivery: Int): Int {',
			'    return (order.total ?: 0) + delivery',
			'}'
		],
		checks: ['check(amountDue(Order(1, 500, null), 200) == 700)', 'check(amountDue(Order(2, null, null), 200) == 200)'],
		defects: [
			{
				kind: 'elvis-precedence',
				line: 4,
				text: '    return order.total ?: 0 + delivery',
				neighbour: { line: 3, text: 'fun amountDue(order: Order, delivery: Int = 0): Int {' }
			}
		],
		decoy: { line: 4, text: '    return order.total ?: 0 + delivery' }
	},
	{
		name: 'listHeight',
		lines: [
			...kdoc('Высота списка в dp: число строк rows (null — 0), умноженное на высоту строки rowHeight.'),
			'fun listHeight(rows: Int?, rowHeight: Int): Int {',
			'    return (rows ?: 0) * rowHeight',
			'}'
		],
		checks: ['check(listHeight(3, 48) == 144)', 'check(listHeight(null, 48) == 0)'],
		defects: [
			{
				kind: 'elvis-precedence',
				line: 4,
				text: '    return rows ?: 0 * rowHeight',
				neighbour: { line: 3, text: 'fun listHeight(rows: Int?, rowHeight: Int = 48): Int {' }
			}
		],
		decoy: { line: 4, text: '    return rows ?: 0 * rowHeight' }
	},
	{
		name: 'discountPercent',
		lines: [
			...kdoc('Скидка в процентах: личная personal (null — 0) плюс 5 для участника клуба (member).'),
			'fun discountPercent(personal: Int?, member: Boolean): Int {',
			'    val bonus = if (member) 5 else 0',
			'    return (personal ?: 0) + bonus',
			'}'
		],
		checks: [
			'check(discountPercent(10, true) == 15)',
			'check(discountPercent(null, true) == 5)',
			'check(discountPercent(10, false) == 10)'
		],
		defects: [
			{
				kind: 'elvis-precedence',
				line: 5,
				text: '    return personal ?: 0 + bonus',
				neighbour: { line: 4, text: '    val bonus = if (!member) 0 else 5' }
			}
		],
		decoy: { line: 4, text: '    val bonus = if (member) 0 else 5' }
	},
	{
		name: 'pageNumbers',
		lines: [
			...kdoc('Номера страниц от 1 до pages включительно; при pages = 0 — пустой список.'),
			'fun pageNumbers(pages: Int): List<Int> {',
			'    return (1..pages).toList()',
			'}'
		],
		checks: ['check(pageNumbers(3) == listOf(1, 2, 3))', 'check(pageNumbers(0).isEmpty())'],
		defects: [
			{
				kind: 'range-bound',
				line: 4,
				text: '    return (1 until pages).toList()',
				neighbour: { line: 3, text: 'fun pageNumbers(pages: Int): Collection<Int> {' }
			}
		],
		decoy: { line: 4, text: '    return (0..pages).toList()' }
	},
	{
		name: 'previewLines',
		lines: [
			...kdoc('Первые n строк сообщения (все, если строк меньше n).'),
			'fun previewLines(lines: List<String>, n: Int): List<String> {',
			'    return (0 until minOf(n, lines.size)).map { lines[it] }',
			'}'
		],
		checks: [
			'check(previewLines(listOf("a", "b", "c"), 2) == listOf("a", "b"))',
			'check(previewLines(listOf("a"), 5) == listOf("a"))'
		],
		defects: [
			{
				kind: 'range-bound',
				line: 4,
				text: '    return (0..minOf(n, lines.size)).map { lines[it] }',
				neighbour: { line: 3, text: 'fun previewLines(lines: List<String>, n: Int = 1): List<String> {' }
			}
		],
		decoy: { line: 4, text: '    return (0 until minOf(n, lines.size - 1)).map { lines[it] }' }
	},
	{
		name: 'lastIndices',
		lines: [
			...kdoc('Индексы последних k элементов списка размера size по возрастанию; k не больше size.'),
			'fun lastIndices(size: Int, k: Int): List<Int> {',
			'    return (size - k until size).toList()',
			'}'
		],
		checks: ['check(lastIndices(5, 2) == listOf(3, 4))', 'check(lastIndices(3, 0).isEmpty())'],
		defects: [
			{
				kind: 'range-bound',
				line: 4,
				text: '    return (size - k..size).toList()',
				neighbour: { line: 3, text: 'fun lastIndices(size: Int, k: Int = 1): List<Int> {' }
			}
		],
		decoy: { line: 4, text: '    return (size - k..size).toList()' }
	},
	{
		name: 'ratingSum',
		lines: [
			...kdoc('Сумма оценок ratings с индекса from по индекс to включительно; 0, если from > to.'),
			'fun ratingSum(ratings: List<Int>, from: Int, to: Int): Int {',
			'    var sum = 0',
			'    for (i in from..to) sum += ratings[i]',
			'    return sum',
			'}'
		],
		checks: [
			'check(ratingSum(listOf(1, 2, 3, 4), 1, 2) == 5)',
			'check(ratingSum(listOf(5), 0, 0) == 5)',
			'check(ratingSum(listOf(1, 2, 3), 2, 1) == 0)'
		],
		defects: [
			{
				kind: 'range-bound',
				line: 5,
				text: '    for (i in from until to) sum += ratings[i]',
				neighbour: { line: 6, text: '    return sum + 0' }
			}
		],
		decoy: { line: 5, text: '    for (i in from until to) sum += ratings[i]' }
	},
	{
		name: 'canSend',
		lines: [
			...kdoc('Можно ли отправить комментарий: он не null и не состоит из одних пробелов.'),
			'fun canSend(comment: String?): Boolean {',
			'    return !comment.isNullOrBlank()',
			'}'
		],
		checks: ['check(canSend(null) == false)', 'check(canSend("   ") == false)', 'check(canSend(" ok ") == true)'],
		defects: [
			{
				kind: 'lookup-api',
				line: 4,
				text: '    return !comment.isNullOrEmpty()',
				neighbour: { line: 3, text: 'fun canSend(comment: String?): Boolean? {' }
			}
		],
		decoy: { line: 4, text: '    return !comment.isNullOrEmpty()' }
	},
	{
		name: 'findMessage',
		needs: ['Message', 'User'],
		lines: [
			...kdoc('Сообщение с данным id или null, если его нет в списке.'),
			'fun findMessage(messages: List<Message>, id: Int): Message? {',
			'    return messages.firstOrNull { it.id == id }',
			'}'
		],
		checks: [
			'val m = listOf(Message(1, "hi", null), Message(2, null, null))',
			'check(findMessage(m, 2)?.id == 2)',
			'check(findMessage(m, 7) == null)'
		],
		defects: [
			{
				kind: 'lookup-api',
				line: 4,
				text: '    return messages.first { it.id == id }',
				neighbour: { line: 3, text: 'fun findMessage(messages: List<Message>, id: Int): Message {' }
			}
		],
		decoy: { line: 4, text: '    return messages.first { it.id == id }' }
	},
	{
		name: 'tabRoute',
		lines: [
			...kdoc('Маршрут вкладки по индексу; для индекса вне списка — «home».'),
			'fun tabRoute(tabs: List<String>, index: Int): String {',
			'    return tabs.getOrNull(index) ?: "home"',
			'}'
		],
		checks: [
			'check(tabRoute(listOf("feed", "cart"), 1) == "cart")',
			'check(tabRoute(listOf("feed"), 3) == "home")',
			'check(tabRoute(listOf("feed"), -1) == "home")'
		],
		defects: [
			{
				kind: 'lookup-api',
				line: 4,
				text: '    return tabs.get(index) ?: "home"',
				neighbour: { line: 3, text: 'fun tabRoute(tabs: List<String>, index: Int = 0): String {' }
			}
		],
		decoy: { line: 4, text: '    return tabs.get(index) ?: "home"' }
	},
	{
		name: 'firstHint',
		lines: [
			...kdoc('Первая непустая подсказка (не null и не пустая строка) или «—», если таких нет.'),
			'fun firstHint(hints: List<String?>): String {',
			'    return hints.firstOrNull { !it.isNullOrEmpty() } ?: "—"',
			'}'
		],
		checks: ['check(firstHint(listOf(null, "", "Поиск")) == "Поиск")', 'check(firstHint(listOf(null)) == "—")'],
		defects: [
			{
				kind: 'lookup-api',
				line: 4,
				text: '    return hints.first { !it.isNullOrEmpty() } ?: "—"',
				neighbour: { line: 3, text: 'fun firstHint(hints: List<String?>): String? {' }
			}
		],
		decoy: { line: 4, text: '    return hints.first { !it.isNullOrEmpty() } ?: "—"' }
	}
];

const JUNIOR: KtUnit[] = [
	{
		name: 'ProfilePresenter',
		needs: ['User'],
		lines: [
			...kdoc('Презентер профиля. До bind() заголовок — «Загрузка», после — имя пользователя', 'или «Без имени».'),
			'class ProfilePresenter {',
			'    private var user: User? = null',
			'',
			'    fun bind(u: User) {',
			'        user = u',
			'    }',
			'',
			'    fun header(): String = user?.let { it.name ?: "Без имени" } ?: "Загрузка"',
			'}'
		],
		checks: [
			'val p = ProfilePresenter()',
			'check(p.header() == "Загрузка")',
			'p.bind(User(1, "Ия", null))',
			'check(p.header() == "Ия")',
			'p.bind(User(2, null, null))',
			'check(p.header() == "Без имени")'
		],
		defects: [
			{
				kind: 'lateinit',
				line: 5,
				text: '    private lateinit var user: User',
				neighbour: { line: 8, text: '        user = u.copy()' }
			}
		],
		decoy: { line: 11, text: '    fun header(): String = user?.let { it.name!! } ?: "Загрузка"' }
	},
	{
		name: 'FeedAdapter',
		lines: [
			...kdoc('Адаптер ленты. itemCount — 0, пока данные не заданы через submit(), затем размер списка.'),
			'class FeedAdapter {',
			'    private var items: List<String>? = null',
			'',
			'    fun submit(list: List<String>) {',
			'        items = list',
			'    }',
			'',
			'    val itemCount: Int',
			'        get() = items?.size ?: 0',
			'}'
		],
		checks: [
			'val a = FeedAdapter()',
			'check(a.itemCount == 0)',
			'a.submit(listOf("x", "y"))',
			'check(a.itemCount == 2)'
		],
		defects: [
			{
				kind: 'lateinit',
				line: 4,
				text: '    private lateinit var items: List<String>',
				neighbour: { line: 7, text: '        items = list.toList()' }
			}
		],
		decoy: { line: 11, text: '        get() = items!!.size' }
	},
	{
		name: 'aboutStatus',
		lines: [
			...kdoc('Статус поля «О себе»: null — «не заполнено», пустая строка — «пусто», иначе — число символов.'),
			'fun aboutStatus(about: String?): String {',
			'    val text = about ?: return "не заполнено"',
			'    return if (text.isEmpty()) "пусто" else "${text.length}"',
			'}'
		],
		checks: [
			'check(aboutStatus(null) == "не заполнено")',
			'check(aboutStatus("") == "пусто")',
			'check(aboutStatus("abc") == "3")'
		],
		defects: [
			{
				kind: 'or-empty',
				line: 4,
				text: '    val text = about.orEmpty()',
				neighbour: { line: 5, text: '    return if (text.length == 0) "пусто" else text.length.toString()' }
			}
		],
		decoy: { line: 4, text: '    val text = about.orEmpty()' }
	},
	{
		name: 'tagCount',
		lines: [
			...kdoc('Число тегов заметки. null — теги ещё не загружены: результат null; пустой список — тегов нет: 0.'),
			'fun tagCount(tags: List<String>?): Int? {',
			'    return tags?.size',
			'}'
		],
		checks: ['check(tagCount(null) == null)', 'check(tagCount(emptyList()) == 0)', 'check(tagCount(listOf("a")) == 1)'],
		defects: [
			{
				kind: 'or-empty',
				line: 4,
				text: '    return tags.orEmpty().size',
				neighbour: { line: 3, text: 'fun tagCount(tags: Collection<String>?): Int? {' }
			}
		],
		decoy: { line: 4, text: '    return tags.orEmpty().size' }
	},
	{
		name: 'searchQuery',
		lines: [
			...kdoc(
				'Параметр запроса поиска: null, если пользователь ничего не вводил (input == null);',
				'введённая строка без пробелов по краям — иначе, в том числе пустая.'
			),
			'fun searchQuery(input: String?): String? {',
			'    return input?.trim()',
			'}'
		],
		checks: [
			'check(searchQuery(null) == null)',
			'check(searchQuery("  ") == "")',
			'check(searchQuery(" cat ") == "cat")'
		],
		defects: [
			{
				kind: 'or-empty',
				line: 5,
				text: '    return input.orEmpty().trim()',
				neighbour: { line: 4, text: 'fun searchQuery(input: String?): CharSequence? {' }
			}
		],
		decoy: { line: 5, text: '    return input.orEmpty().trim()' }
	},
	{
		name: 'DraftStore',
		lines: [
			...kdoc(
				'Черновик сообщения. send() отправляет черновик: записывает его текст в sent, очищает черновик',
				'и возвращает отправленный текст; без черновика возвращает null.'
			),
			'class DraftStore {',
			'    var draft: String? = null',
			'    val sent = mutableListOf<String>()',
			'',
			'    private fun clear() {',
			'        draft = null',
			'    }',
			'',
			'    fun send(): String? {',
			'        val text = draft',
			'        if (text != null) {',
			'            clear()',
			'            sent.add(text)',
			'            return text',
			'        }',
			'        return null',
			'    }',
			'}'
		],
		checks: [
			'val d = DraftStore()',
			'check(d.send() == null)',
			'd.draft = "Привет"',
			'check(d.send() == "Привет")',
			'check(d.draft == null && d.sent == listOf("Привет"))'
		],
		defects: [
			{
				kind: 'stale-property',
				line: 17,
				text: '            return draft',
				neighbour: { line: 16, text: '            sent += text' }
			}
		],
		decoy: { line: 16, text: '            sent.add(draft ?: text)' }
	},
	{
		name: 'Session',
		lines: [
			...kdoc(
				'Сессия. logout() завершает сессию: сбрасывает токен, пишет в log «выход: <токен>» и возвращает',
				'токен завершённой сессии; если входа не было — null, log не меняется.'
			),
			'class Session {',
			'    var token: String? = null',
			'    val log = mutableListOf<String>()',
			'',
			'    fun logout(): String? {',
			'        val current = token ?: return null',
			'        token = null',
			'        log.add("выход: $current")',
			'        return current',
			'    }',
			'}'
		],
		checks: [
			'val s = Session()',
			'check(s.logout() == null && s.log.isEmpty())',
			's.token = "t1"',
			'check(s.logout() == "t1")',
			'check(s.token == null && s.log == listOf("выход: t1"))'
		],
		defects: [
			{
				kind: 'stale-property',
				line: 12,
				text: '        return token',
				neighbour: { line: 11, text: '        log += "выход: $current"' }
			}
		],
		decoy: { line: 10, text: '        token = token?.let { null }' }
	},
	{
		name: 'Uploader',
		lines: [
			...kdoc(
				'Загрузка вложения. finish() завершает текущую загрузку: убирает её из pending, добавляет её имя',
				'в done и возвращает его; если загрузки нет — null.'
			),
			'class Uploader {',
			'    var pending: String? = null',
			'    val done = mutableListOf<String>()',
			'',
			'    fun finish(): String? {',
			'        val name = pending ?: return null',
			'        pending = null',
			'        done.add(name)',
			'        return name',
			'    }',
			'}'
		],
		checks: [
			'val u = Uploader()',
			'check(u.finish() == null)',
			'u.pending = "photo.jpg"',
			'check(u.finish() == "photo.jpg")',
			'check(u.pending == null && u.done == listOf("photo.jpg"))'
		],
		defects: [
			{
				kind: 'stale-property',
				line: 11,
				text: '        done.add("$pending")',
				neighbour: { line: 9, text: '        val name = pending?.toString() ?: return null' }
			}
		],
		decoy: { line: 10, text: '        pending = pending?.let { null }' }
	},
	{
		name: 'ChatScreen',
		lines: [
			...kdoc(
				'Экран чата. После onDestroyView() представления нет (null): render() ничего не рисует',
				'и возвращает false; до этого дописывает текст и возвращает true.'
			),
			'class ChatScreen {',
			'    var view: StringBuilder? = StringBuilder()',
			'',
			'    fun onDestroyView() {',
			'        view = null',
			'    }',
			'',
			'    fun render(text: String): Boolean {',
			'        val v = view ?: return false',
			'        v.append(text)',
			'        return true',
			'    }',
			'}'
		],
		checks: ['val s = ChatScreen()', 'check(s.render("a"))', 's.onDestroyView()', 'check(!s.render("b"))'],
		defects: [
			{
				kind: 'destroyed-view',
				line: 12,
				text: '        val v = view!!',
				neighbour: { line: 8, text: '        view?.setLength(0)' }
			}
		],
		decoy: { line: 12, text: '        val v = view!!' }
	},
	{
		name: 'SearchFragment',
		lines: [
			...kdoc(
				'Фрагмент поиска. После onDestroyView() привязки нет: showResults() возвращает 0;',
				'до этого показывает результаты и возвращает их число.'
			),
			'class SearchFragment {',
			'    private var binding: MutableList<String>? = mutableListOf()',
			'',
			'    fun onDestroyView() {',
			'        binding = null',
			'    }',
			'',
			'    fun showResults(results: List<String>): Int {',
			'        binding?.addAll(results) ?: return 0',
			'        return results.size',
			'    }',
			'}'
		],
		checks: [
			'val f = SearchFragment()',
			'check(f.showResults(listOf("a")) == 1)',
			'f.onDestroyView()',
			'check(f.showResults(listOf("b", "c")) == 0)'
		],
		defects: [
			{
				kind: 'destroyed-view',
				line: 12,
				text: '        binding!!.addAll(results)',
				neighbour: { line: 8, text: '        binding?.clear()' }
			}
		],
		decoy: { line: 12, text: '        binding!!.addAll(results)' }
	},
	{
		name: 'PlayerScreen',
		lines: [
			...kdoc(
				'Экран плеера. onStop() отпускает плеер (null). Колбэк onProgress(sec), пришедший после',
				'onStop(), игнорируется: возвращает -1; до этого запоминает позицию и возвращает её.'
			),
			'class PlayerScreen {',
			'    private var player: MutableList<Int>? = mutableListOf()',
			'',
			'    fun onStop() {',
			'        player = null',
			'    }',
			'',
			'    fun onProgress(sec: Int): Int {',
			'        val p = player ?: return -1',
			'        p.add(sec)',
			'        return sec',
			'    }',
			'}'
		],
		checks: ['val s = PlayerScreen()', 'check(s.onProgress(5) == 5)', 's.onStop()', 'check(s.onProgress(6) == -1)'],
		defects: [
			{
				kind: 'destroyed-view',
				line: 12,
				text: '        val p = player as MutableList<Int>',
				neighbour: { line: 8, text: '        player?.clear()' }
			}
		],
		decoy: { line: 12, text: '        val p = player!!' }
	}
];

const MARKDOWN =
	'Модуль экрана на Kotlin 2.4 (Kotlin/JVM, JVM 21). У каждой функции и класса в KDoc-комментарии записана ' +
	'спецификация. Ровно одна строка модуля нарушает спецификацию своей функции или класса. Введите номер этой строки ' +
	'(нумерация с 1). Если исправить можно в нескольких строках — засчитывается любая из них, где замена одной ' +
	'инструкцией восстанавливает спецификацию. Исправление — одна простая инструкция того же вида, что исправляемая ' +
	'строка: в ней можно менять операторы, вызовы, значения и типы (в том числе заменить `!!`, `as` или вызов на `?.` ' +
	'или `?:` со значением по умолчанию), но не добавляйте конструкций, которых в ней нет (новые лямбды, `?.let`, ' +
	'`if`-выражения, обёртки, новые функции), и не переносите в неё логику из другой строки.';

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const library = input.grade === 'intern' ? INTERN : JUNIOR;
	const module = composeDefect(rng, library, input.classId, input.grade === 'intern' ? 4 : 3, TYPES, HEADER);
	return defectBuilt(descriptor, input, module, MARKDOWN);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
