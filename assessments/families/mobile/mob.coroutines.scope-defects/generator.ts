// A module of a screen's data layer on coroutines, each function with its specification in KDoc; exactly one line
// breaks its function's specification: a result nobody waited for, a cancellation swallowed by a broad `catch`, a scope
// that cancels (or does not cancel) siblings against the specification, work detached from the caller's job, a loop
// that never notices the cancellation, a cleanup that suspends in a cancelled coroutine. The candidate names that line.
// The kind of the defect is the essential class; the other functions, their order and the module header are surface.
// The checks run in a single-threaded `runBlocking` and order the coroutines with `yield` and explicit joins only.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { kotlinDefectProbe, kotlinDefectRuns } from '../../_lib/kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** A replaced line: its index in the function (0-based) and its new text. */
interface Edit {
	line: number;
	text: string;
}

/** A function of the module: its lines (KDoc and code), the checks of its specification and its possible defects. */
interface Fn {
	name: string;
	lines: string[];
	/** Kotlin statements inside `runBlocking`; each throws when the specification is broken. */
	checks: string[];
	defects: { kind: string; edit: Edit; neighbour: Edit }[];
	/** A line that looks suspicious when the function is shown as context, with the change a wrong guess makes there. */
	bait: Edit;
}

const kdoc = (...text: string[]): string[] => ['/**', ...text.map((t) => ` * ${t}`), ' */'];

const LOAD_SECTIONS: Fn = {
	name: 'loadSections',
	lines: [
		...kdoc(
			'Загружает разделы экрана параллельно. К возврату из функции результат содержит',
			'все разделы: ключ — имя раздела, значение — ответ [fetch].'
		),
		'suspend fun loadSections(names: List<String>, fetch: suspend (String) -> String): Map<String, String> {',
		'    val result = mutableMapOf<String, String>()',
		'    coroutineScope {',
		'        for (name in names) launch { result[name] = fetch(name) }',
		'    }',
		'    return result',
		'}'
	],
	checks: [
		'val sections = loadSections(listOf("header", "feed", "footer")) { yield(); it.uppercase() }',
		'check(sections == mapOf("header" to "HEADER", "feed" to "FEED", "footer" to "FOOTER")) { "loadSections: $sections" }'
	],
	defects: [
		{
			kind: 'not-awaited',
			edit: { line: 6, text: '    with(CoroutineScope(currentCoroutineContext())) {' },
			neighbour: { line: 7, text: '        for (name in names) launch { result.put(name, fetch(name)) }' }
		}
	],
	bait: { line: 7, text: '        for (name in names) result[name] = fetch(name)' }
};

const OPEN_CARD: Fn = {
	name: 'openCard',
	lines: [
		...kdoc('Открывает карточку товара: дожидается предзагрузки карточки в [cache]', 'и возвращает её из кэша.'),
		'suspend fun openCard(id: Int, cache: MutableMap<Int, String>, fetch: suspend (Int) -> String): String =',
		'    coroutineScope {',
		'        val prefetch = launch { cache[id] = fetch(id) }',
		'        prefetch.join()',
		'        cache.getValue(id)',
		'    }'
	],
	checks: [
		'val cache = mutableMapOf<Int, String>()',
		'check(openCard(7, cache) { yield(); "card $it" } == "card 7") { "openCard" }'
	],
	defects: [
		{
			kind: 'not-awaited',
			edit: { line: 7, text: '        prefetch.start()' },
			neighbour: {
				line: 6,
				text: '        val prefetch = launch(start = CoroutineStart.DEFAULT) { cache[id] = fetch(id) }'
			}
		}
	],
	bait: { line: 8, text: '        cache[id] ?: ""' }
};

const FETCH_WITH_RETRY: Fn = {
	name: 'fetchWithRetry',
	lines: [
		...kdoc(
			'Делает до [attempts] попыток запроса, пока он падает с IOException, и возвращает',
			'первый ответ; после последней неудачи — null. Другие ошибки и отмена не перехватываются.'
		),
		'suspend fun fetchWithRetry(attempts: Int, log: MutableList<String>, request: suspend (Int) -> String): String? {',
		'    repeat(attempts) { i ->',
		'        try {',
		'            return request(i + 1)',
		'        } catch (e: IOException) {',
		'            log.add("attempt ${i + 1} failed")',
		'        }',
		'    }',
		'    return null',
		'}'
	],
	checks: [
		'val log = mutableListOf<String>()',
		'check(fetchWithRetry(3, log) { n -> if (n < 3) throw IOException("net") else "page $n" } == "page 3") { "fetchWithRetry: retries" }',
		'val calls = mutableListOf<Int>()',
		'val job = launch { fetchWithRetry(3, log) { n -> calls.add(n); if (n == 1) throw IOException("net"); awaitCancellation() } }',
		'yield()',
		'job.cancelAndJoin()',
		'check(calls == listOf(1, 2)) { "fetchWithRetry: requests after the cancellation $calls" }',
		'val failed = try { fetchWithRetry(2, log) { error("bad request") }; false } catch (e: IllegalStateException) { true }',
		'check(failed) { "fetchWithRetry: swallowed an error" }'
	],
	defects: [
		{
			kind: 'swallowed-cancel',
			edit: { line: 8, text: '        } catch (e: Exception) {' },
			neighbour: { line: 5, text: '    for (i in 0 until attempts) {' }
		}
	],
	bait: { line: 8, text: '        } catch (e: java.io.IOException) {' }
};

const READ_PAGES: Fn = {
	name: 'readPages',
	lines: [
		...kdoc(
			'Читает страницы ленты по порядку в [out]; страница, загрузка которой упала',
			'с IOException, пропускается. Отмена прекращает чтение: новых запросов нет.'
		),
		'suspend fun readPages(pages: Int, out: MutableList<String>, load: suspend (Int) -> String) {',
		'    for (page in 1..pages) {',
		'        val text = try { load(page) } catch (e: IOException) { continue }',
		'        out.add(text)',
		'    }',
		'}'
	],
	checks: [
		'val out = mutableListOf<String>()',
		'readPages(3, out) { p -> if (p == 2) throw IOException("broken") else "page $p" }',
		'check(out == listOf("page 1", "page 3")) { "readPages: $out" }',
		'val requested = mutableListOf<Int>()',
		'val reader = launch { readPages(4, mutableListOf()) { p -> requested.add(p); if (p == 2) awaitCancellation(); yield(); "page $p" } }',
		'repeat(3) { yield() }',
		'reader.cancelAndJoin()',
		'check(requested == listOf(1, 2)) { "readPages: requests after the cancellation $requested" }'
	],
	defects: [
		{
			kind: 'swallowed-cancel',
			edit: { line: 6, text: '        val text = try { load(page) } catch (e: Exception) { continue }' },
			neighbour: { line: 7, text: '        out += text' }
		}
	],
	bait: { line: 6, text: '        val text = try { load(page) } catch (e: java.io.IOException) { continue }' }
};

const REFRESH_PROFILE: Fn = {
	name: 'refreshProfile',
	lines: [
		...kdoc(
			'Обновляет профиль: ошибка сети (IOException) даёт null и запись в [log].',
			'Отмена вызывающей корутины не перехватывается: после неё в log ничего не пишется.'
		),
		'suspend fun refreshProfile(log: MutableList<String>, fetch: suspend () -> String): String? {',
		'    val profile = try { fetch() } catch (e: IOException) { null }',
		'    log.add("profile refreshed")',
		'    return profile',
		'}'
	],
	checks: [
		'val profileLog = mutableListOf<String>()',
		'check(refreshProfile(profileLog) { throw IOException("offline") } == null) { "refreshProfile: offline" }',
		'profileLog.clear()',
		'val refresh = launch { refreshProfile(profileLog) { awaitCancellation() } }',
		'yield()',
		'refresh.cancelAndJoin()',
		'check(profileLog.isEmpty()) { "refreshProfile: went on after the cancellation" }'
	],
	defects: [
		{
			kind: 'swallowed-cancel',
			edit: { line: 5, text: '    val profile = runCatching { fetch() }.getOrNull()' },
			neighbour: { line: 6, text: '    log += "profile refreshed"' }
		}
	],
	bait: { line: 7, text: '    return profile ?: null' }
};

const REFRESH_FEEDS: Fn = {
	name: 'refreshFeeds',
	lines: [
		...kdoc(
			'Обновляет ленты параллельно. Сбой одной ленты не отменяет остальные;',
			'возвращает ленты, обновлённые успешно, в порядке [feeds].'
		),
		'suspend fun refreshFeeds(feeds: List<String>, load: suspend (String) -> Unit): List<String> =',
		'    supervisorScope {',
		'        val loads = feeds.map { feed -> async { load(feed) } }',
		'        feeds.filterIndexed { i, _ -> runCatching { loads[i].await() }.isSuccess }',
		'    }'
	],
	checks: [
		'val refreshed = refreshFeeds(listOf("news", "sport", "music")) { feed -> yield(); if (feed == "sport") throw IOException("down") }',
		'check(refreshed == listOf("news", "music")) { "refreshFeeds: $refreshed" }'
	],
	defects: [
		{
			kind: 'failure-scope',
			edit: { line: 5, text: '    coroutineScope {' },
			neighbour: {
				line: 7,
				text: '        feeds.filterIndexed { i, _ -> try { loads[i].await(); true } catch (e: IOException) { false } }'
			}
		}
	],
	bait: { line: 7, text: '        feeds.filterIndexed { i, _ -> runCatching { loads[i].await() }.isSuccess }.toList()' }
};

const UPLOAD_ALL: Fn = {
	name: 'uploadAll',
	lines: [
		...kdoc(
			'Выгружает фото параллельно. Если одна выгрузка упала, остальные отменяются,',
			'а ошибка выходит из функции; [uploaded] получает только завершённые выгрузки.'
		),
		'suspend fun uploadAll(photos: List<String>, uploaded: MutableList<String>, upload: suspend (String) -> Unit) =',
		'    coroutineScope {',
		'        for (photo in photos) {',
		'            launch { upload(photo); uploaded.add(photo) }',
		'        }',
		'    }'
	],
	checks: [
		'val uploaded = mutableListOf<String>()',
		'val uploadFailed = try {',
		'    uploadAll(listOf("a.jpg", "b.jpg", "c.jpg"), uploaded) { p -> repeat(if (p == "c.jpg") 3 else 1) { yield() }; if (p == "b.jpg") throw IOException("quota") }',
		'    false',
		'} catch (e: IOException) { true }',
		'check(uploadFailed && uploaded == listOf("a.jpg")) { "uploadAll: $uploadFailed $uploaded" }'
	],
	defects: [
		{
			kind: 'failure-scope',
			edit: { line: 5, text: '    supervisorScope {' },
			neighbour: { line: 7, text: '            launch { uploaded.add(photo.also { upload(it) }) }' }
		}
	],
	bait: { line: 7, text: '            launch { upload(photo); uploaded += photo }' }
};

const LOAD_HEADER: Fn = {
	name: 'loadHeader',
	lines: [
		...kdoc(
			'Загружает аватар и баннер параллельно. Баннер необязателен: его сбой не отменяет',
			'загрузку аватара, вместо баннера возвращается null. Сбой аватара выходит из функции.'
		),
		'suspend fun loadHeader(avatar: suspend () -> String, banner: suspend () -> String): Pair<String, String?> =',
		'    supervisorScope {',
		'        val b = async { banner() }',
		'        val a = async { avatar() }',
		'        val shownBanner = try { b.await() } catch (e: IOException) { null }',
		'        a.await() to shownBanner',
		'    }'
	],
	checks: [
		'val header = loadHeader({ yield(); yield(); "me.png" }, { yield(); throw IOException("no banner") })',
		'check(header == ("me.png" to null)) { "loadHeader: $header" }',
		'val avatarFailed = try { loadHeader({ yield(); throw IOException("no avatar") }, { "ad.png" }); false } catch (e: IOException) { true }',
		'check(avatarFailed) { "loadHeader: the failure of the avatar was swallowed" }'
	],
	defects: [
		{
			kind: 'failure-scope',
			edit: { line: 5, text: '    coroutineScope {' },
			neighbour: { line: 8, text: '        val shownBanner = runCatching { b.await() }.getOrNull()' }
		}
	],
	bait: { line: 9, text: '        Pair(a.await(), shownBanner)' }
};

const SAVE_DRAFT: Fn = {
	name: 'saveDraftAsync',
	lines: [
		...kdoc(
			'Запускает сохранение черновика в фоне и сразу возвращает его Job. Сохранение —',
			'дочерняя работа вызывающего scope: отмена scope отменяет и сохранение.'
		),
		'fun CoroutineScope.saveDraftAsync(text: String, store: MutableList<String>, write: suspend (String) -> Unit): Job =',
		'    launch {',
		'        write(text)',
		'        store.add(text)',
		'    }'
	],
	checks: [
		'val store = mutableListOf<String>()',
		'val draftScreen = launch {',
		'    saveDraftAsync("draft", store) { yield(); yield() }',
		'    awaitCancellation()',
		'}',
		'yield()',
		'draftScreen.cancelAndJoin()',
		'repeat(5) { yield() }',
		'check(store.isEmpty()) { "saveDraftAsync outlived its scope" }',
		'val saved = saveDraftAsync("note", store) { yield() }',
		'check(store.isEmpty()) { "saveDraftAsync waited for the save" }',
		'saved.join()',
		'check(store == listOf("note")) { "saveDraftAsync: $store" }'
	],
	defects: [
		{
			kind: 'detached',
			edit: { line: 5, text: '    launch(Job()) {' },
			neighbour: { line: 6, text: '        write(text.trim())' }
		}
	],
	bait: { line: 7, text: '        store += text' }
};

const START_POLLING: Fn = {
	name: 'startPolling',
	lines: [
		...kdoc(
			'Запускает опрос сервера в [scope] экрана: [ticks] раз вызывает [refresh].',
			'После отмены scope новых вызовов refresh нет.'
		),
		'fun startPolling(scope: CoroutineScope, ticks: Int, refresh: suspend (Int) -> Unit): Job =',
		'    scope.launch {',
		'        for (tick in 1..ticks) refresh(tick)',
		'    }'
	],
	checks: [
		'val ticks = mutableListOf<Int>()',
		'val pollScreen = launch {',
		'    startPolling(this, 4) { ticks.add(it); yield() }',
		'    awaitCancellation()',
		'}',
		'repeat(3) { yield() }',
		'pollScreen.cancelAndJoin()',
		'repeat(10) { yield() }',
		'check(ticks.size < 4) { "startPolling outlived the screen: $ticks" }'
	],
	defects: [
		{
			kind: 'detached',
			edit: { line: 5, text: '    scope.launch(SupervisorJob()) {' },
			neighbour: { line: 6, text: '        repeat(ticks) { refresh(it + 1) }' }
		}
	],
	bait: { line: 6, text: '        for (tick in 1..ticks) { refresh(tick) }' }
};

const SYNC_CART: Fn = {
	name: 'syncCart',
	lines: [
		...kdoc(
			'Выгружает позиции корзины по одной и возвращается, когда выгружены все.',
			'Выгрузка — часть вызывающей корутины: её отмена прекращает выгрузку.'
		),
		'suspend fun syncCart(items: List<String>, uploaded: MutableList<String>, upload: suspend (String) -> Unit) =',
		'    coroutineScope {',
		'        for (item in items) {',
		'            upload(item)',
		'            uploaded.add(item)',
		'        }',
		'    }'
	],
	checks: [
		'val cartUploaded = mutableListOf<String>()',
		'val sync = launch { syncCart(listOf("milk", "bread", "eggs"), cartUploaded) { yield() } }',
		'repeat(2) { yield() }',
		'sync.cancelAndJoin()',
		'check(cartUploaded.size < 3) { "syncCart ignored the cancellation: $cartUploaded" }'
	],
	defects: [
		{
			kind: 'detached',
			edit: { line: 5, text: '    withContext(NonCancellable) {' },
			neighbour: { line: 7, text: '            upload(item.trim())' }
		}
	],
	bait: { line: 8, text: '            uploaded += item' }
};

const COUNT_UNREAD: Fn = {
	name: 'countUnreadAsync',
	lines: [
		...kdoc(
			'Считает непрочитанные сообщения по чатам в фоне. Подсчёт — дочерняя работа scope:',
			'отмена scope отменяет и подсчёт; [counted] получает чаты, которые успели посчитать.'
		),
		'fun CoroutineScope.countUnreadAsync(chats: List<String>, counted: MutableList<String>, unread: suspend (String) -> Int): Deferred<Int> =',
		'    async {',
		'        chats.sumOf { chat -> unread(chat).also { counted.add(chat) } }',
		'    }'
	],
	checks: [
		'val counted = mutableListOf<String>()',
		'val chatsScreen = launch {',
		'    countUnreadAsync(listOf("work", "family", "news"), counted) { yield(); 2 }',
		'    awaitCancellation()',
		'}',
		'yield()',
		'chatsScreen.cancelAndJoin()',
		'repeat(8) { yield() }',
		'check(counted.isEmpty()) { "countUnreadAsync outlived its scope: $counted" }',
		'check(countUnreadAsync(listOf("a", "b"), counted) { 3 }.await() == 6) { "countUnreadAsync: sum" }'
	],
	defects: [
		{
			kind: 'detached',
			edit: { line: 5, text: '    async(SupervisorJob()) {' },
			neighbour: { line: 6, text: '        chats.map { chat -> unread(chat).also { counted.add(chat) } }.sum()' }
		}
	],
	bait: { line: 6, text: '        chats.sumOf { chat -> unread(chat).also { _ -> counted.add(chat) } }' }
};

const INDEX_MESSAGES: Fn = {
	name: 'indexMessages',
	lines: [
		...kdoc(
			'Индексирует сообщения по одному в [index]. Если [stop] вернул true, индексация',
			'отменяется: следующие сообщения не индексируются.'
		),
		'suspend fun indexMessages(messages: List<String>, index: MutableList<String>, stop: (String) -> Boolean) =',
		'    coroutineScope {',
		'        launch {',
		'            var i = 0',
		'            while (isActive && i < messages.size) {',
		'                index.add(messages[i])',
		'                if (stop(messages[i])) cancel()',
		'                i += 1',
		'            }',
		'        }.join()',
		'    }'
	],
	checks: [
		'val index = mutableListOf<String>()',
		'indexMessages(listOf("hi", "spam", "bye", "ok"), index) { it == "spam" }',
		'check(index == listOf("hi", "spam")) { "indexMessages: $index" }'
	],
	defects: [
		{
			kind: 'cooperative',
			edit: { line: 8, text: '            while (i < messages.size) {' },
			neighbour: { line: 11, text: '                i++' }
		}
	],
	bait: { line: 10, text: '                if (stop(messages[i])) this.cancel()' }
};

const COMPRESS_ALL: Fn = {
	name: 'compressAll',
	lines: [
		...kdoc(
			'Сжимает фото по очереди; само сжатие не приостанавливается. Перед каждым фото',
			'уступает поток другим корутинам и останавливается, если вызывающую корутину отменили.',
			'Возвращает число сжатых фото.'
		),
		'suspend fun compressAll(photos: List<String>, compress: (String) -> Unit): Int {',
		'    var done = 0',
		'    for (photo in photos) {',
		'        yield()',
		'        compress(photo)',
		'        done += 1',
		'    }',
		'    return done',
		'}'
	],
	checks: [
		'val compressed = mutableListOf<String>()',
		'lateinit var worker: Job',
		'worker = launch { compressAll(listOf("a.png", "b.png", "c.png")) { p -> compressed.add(p); if (p == "a.png") worker.cancel() } }',
		'worker.join()',
		'check(compressed == listOf("a.png")) { "compressAll: $compressed" }',
		'check(compressAll(listOf("x.png", "y.png")) { } == 2) { "compressAll: count" }'
	],
	defects: [
		{
			kind: 'cooperative',
			edit: { line: 8, text: '        Thread.yield()' },
			neighbour: { line: 10, text: '        done++' }
		}
	],
	bait: { line: 8, text: '        kotlinx.coroutines.yield()' }
};

const EDIT_NOTE: Fn = {
	name: 'editNote',
	lines: [
		...kdoc(
			'Держит редактор заметки открытым, пока его не отменят. При отмене последний текст',
			'обязательно сохраняется через [save], даже если save приостанавливается.'
		),
		'suspend fun editNote(draft: StringBuilder, save: suspend (String) -> Unit, edit: suspend (StringBuilder) -> Unit) {',
		'    try {',
		'        while (true) edit(draft)',
		'    } finally {',
		'        withContext(NonCancellable) { save(draft.toString()) }',
		'    }',
		'}'
	],
	checks: [
		'val savedNotes = mutableListOf<String>()',
		'val draft = StringBuilder()',
		'val editor = launch { editNote(draft, { yield(); savedNotes.add(it) }) { it.append("x"); yield() } }',
		'repeat(3) { yield() }',
		'editor.cancelAndJoin()',
		'check(draft.isNotEmpty() && savedNotes == listOf(draft.toString())) { "editNote: $savedNotes" }'
	],
	defects: [
		{
			kind: 'cleanup',
			edit: { line: 8, text: '        save(draft.toString())' },
			neighbour: { line: 6, text: '        while (currentCoroutineContext().isActive) edit(draft)' }
		}
	],
	bait: { line: 6, text: '        while (true) { edit(draft) }' }
};

const HOLD_CHAT: Fn = {
	name: 'holdChat',
	lines: [
		...kdoc(
			'Держит соединение чата до отмены. При отмене отправляет серверу "bye" (send',
			'приостанавливается) и только после этого записывает "closed" в [log].'
		),
		'suspend fun holdChat(log: MutableList<String>, send: suspend (String) -> Unit) {',
		'    send("hello")',
		'    try {',
		'        awaitCancellation()',
		'    } finally {',
		'        withContext(NonCancellable) { send("bye") }',
		'        log.add("closed")',
		'    }',
		'}'
	],
	checks: [
		'val sent = mutableListOf<String>()',
		'val chatLog = mutableListOf<String>()',
		'val chat = launch { holdChat(chatLog) { yield(); sent.add(it) } }',
		'repeat(3) { yield() }',
		'chat.cancelAndJoin()',
		'check(sent == listOf("hello", "bye") && chatLog == listOf("closed")) { "holdChat: $sent $chatLog" }'
	],
	defects: [
		{
			kind: 'cleanup',
			edit: { line: 9, text: '        send("bye")' },
			neighbour: { line: 10, text: '        log += "closed"' }
		}
	],
	bait: { line: 5, text: '    send("hello".trim())' }
};

/** The functions a module of each level is made of; any of them may carry the defect of its kind. */
const MIDDLE: readonly Fn[] = [
	LOAD_SECTIONS,
	OPEN_CARD,
	FETCH_WITH_RETRY,
	READ_PAGES,
	REFRESH_PROFILE,
	REFRESH_FEEDS,
	UPLOAD_ALL,
	SAVE_DRAFT,
	START_POLLING
];
const SENIOR: readonly Fn[] = [
	...MIDDLE,
	LOAD_HEADER,
	SYNC_CART,
	COUNT_UNREAD,
	INDEX_MESSAGES,
	COMPRESS_ALL,
	EDIT_NOTE,
	HOLD_CHAT
];

const MODULE_TITLES = [
	'Слой данных экрана профиля',
	'Репозиторий ленты',
	'Загрузчики экрана заказов',
	'Фоновые задачи мессенджера',
	'Синхронизация каталога'
];
const HEADER_CONSTANTS = [
	'const val PAGE_SIZE = 20',
	'const val MAX_RETRIES = 3',
	'const val CACHE_TTL_MS = 60_000L',
	'const val FEED_LIMIT = 50',
	'const val API_VERSION = "v2"'
];

interface Module {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
}

function compose(rng: Rng, library: readonly Fn[], kind: string, contextCount: number): Module {
	const candidates = library.flatMap((fn) =>
		fn.defects.filter((d) => d.kind === kind).map((defect) => ({ fn, defect }))
	);
	const { fn: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((fn) => fn !== buggy && !fn.defects.some((d) => d.kind === kind)),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	const usesIo = order.some((fn) => [...fn.lines, ...fn.checks].some((l) => l.includes('IOException')));
	// A header of random length — a comment and constants — so the defect's line number carries no hint.
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 3));
	const lines: string[] = [
		...(usesIo ? ['import java.io.IOException'] : []),
		'import kotlinx.coroutines.*',
		'',
		`// ${rng.pick(MODULE_TITLES)}.`,
		...(constants.length ? ['', ...constants] : []),
		''
	];
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	const baits: { line: number; text: string }[] = [];
	for (const fn of order) {
		const offset = lines.length;
		fn.lines.forEach((line, i) => lines.push(fn === buggy && i === defect.edit.line ? defect.edit.text : line));
		if (fn === buggy) {
			answer = offset + defect.edit.line + 1;
			neighbour = { line: offset + defect.neighbour.line + 1, text: defect.neighbour.text };
		} else baits.push({ line: offset + fn.bait.line + 1, text: fn.bait.text });
		lines.push('');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const check = [
		'',
		'fun main() = runBlocking {',
		...order.flatMap((fn) => ['    run {', ...fn.checks.map((c) => `        ${c}`), '    }']),
		'    println("ok")',
		'}'
	].join('\n');
	return {
		source: lines.join('\n'),
		check,
		answer,
		fix: buggy.lines[defect.edit.line] ?? '',
		neighbour,
		other: rng.pick(baits)
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const m = compose(rng, input.grade === 'middle' ? MIDDLE : SENIOR, input.classId, 3);
	const runs = kotlinDefectRuns({
		source: m.source,
		check: m.check,
		line: m.answer,
		fix: m.fix,
		distractors: [
			{ line: m.neighbour.line, replacement: m.neighbour.text },
			{ line: m.other.line, replacement: m.other.text }
		]
	});
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль Android-приложения на Kotlin (kotlinx.coroutines). У каждой функции в KDoc записана её спецификация. ' +
				'Ровно одна строка модуля нарушает спецификацию своей функции: если заменить только её, все функции будут ' +
				'работать по спецификации. Введите номер этой строки (нумерация с 1).',
			code: { language: 'kotlin', source: m.source }
		},
		answer: { kind: 'line_no', value: m.answer }
	});
	return {
		instance,
		reference: () => kotlinDefectProbe(runs),
		wrong: () => ({
			'neighbour-line': { kind: 'answer', answer: { kind: 'line_no', value: m.neighbour.line } },
			'other-function': { kind: 'answer', answer: { kind: 'line_no', value: m.other.line } }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
