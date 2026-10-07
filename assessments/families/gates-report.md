# Отчёт ворот банка

Среда исполнения: образ песочницы `fsp-sandbox:test` — Python 3.13.15, SQLite 3.46.1. Сидов на класс: 200. Проверено семейств: 1, время 4 с.

## Семейства

| Семейство             | Формат  | Уровни         | Экз. | Эталон: отказов | Ошибочные: поймано | Коллизия | Пересечение классов | Мутанты (убито / всего − экв.) | Перенос | Проблем |
| --------------------- | ------- | -------------- | ---- | --------------- | ------------------ | -------- | ------------------- | ------------------------------ | ------- | ------- |
| `ops.net.subnet-plan` | compute | intern, junior | 1600 | 0               | 9 / 9              | 0.0015   | 0                   | —                              | —       | 0       |

## Ошибочные решения

- `ops.net.subnet-plan`: count-no-subtract — отвергнуто 1048 из 1048; count-minus-one — отвергнуто 925 из 925; octet-round-down — отвергнуто 740 из 740; host-bits-kept — отвергнуто 674 из 674; bcast-next-network — отвергнуто 600 из 600; p2p-like-others — отвергнуто 200 из 200; listed-order — отвергнуто 589 из 589; no-alignment — отвергнуто 320 из 320; stop-on-overflow — отвергнуто 200 из 200

## Проблемы ворот

Нет.

## Валидатор контракта

- (awaiting_raters) family fe.async.async-iteration@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.async.async-iteration@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.async.async-iteration: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.await-order@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.await-order@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.await-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.callback-defects@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.callback-defects@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.callback-defects: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.concurrency-limit@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.concurrency-limit@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.concurrency-limit: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.debounce-throttle@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.debounce-throttle@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.debounce-throttle: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.event-loop-order@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family fe.async.event-loop-order@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.event-loop-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.promise-chains@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.promise-chains@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.async.promise-chains: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.promise-combinators@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.promise-combinators@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.promise-combinators: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.request-races@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.request-races@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.request-races: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.async.retry-abort@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.async.retry-abort@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.async.retry-abort: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.code.form-validation@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family fe.code.form-validation@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family fe.code.form-validation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.code.query-string@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family fe.code.query-string@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family fe.code.query-string: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.code.request-dedupe@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family fe.code.request-dedupe@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family fe.code.request-dedupe: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.code.undo-history@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family fe.code.undo-history@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family fe.code.undo-history: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.dom.accessible-name@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.dom.accessible-name@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.dom.accessible-name: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.dom.box-model@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family fe.dom.box-model: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.dom.cascade@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.dom.cascade@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.dom.cascade: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.dom.event-propagation@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.dom.event-propagation@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.dom.event-propagation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.dom.flex-layout@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.dom.flex-layout@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.dom.flex-layout: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.dom.grid-layout@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.dom.grid-layout@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.dom.grid-layout: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.dom.specificity@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family fe.dom.specificity@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.dom.specificity: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.closures-scope@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family fe.js.closures-scope@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.js.closures-scope: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.coercion@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.js.coercion@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.js.coercion: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.iterators-generators@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.js.iterators-generators@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.js.iterators-generators: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.objects-copying@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.js.objects-copying@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.js.objects-copying: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.prototypes-classes@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.js.prototypes-classes@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.js.prototypes-classes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.spec-defects@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family fe.js.spec-defects@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family fe.js.spec-defects: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.strings-numbers@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family fe.js.strings-numbers: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.this-binding@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.js.this-binding@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.js.this-binding: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.ts-defects@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.js.ts-defects@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.js.ts-defects: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.js.ts-narrowing@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.js.ts-narrowing@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.js.ts-narrowing: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.perf.bundle-chunks@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.perf.bundle-chunks: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.perf.layout-thrashing@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.perf.layout-thrashing@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.perf.layout-thrashing: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.perf.main-thread-budget@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.perf.main-thread-budget: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.perf.resource-loading@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.perf.resource-loading: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.perf.virtual-list@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.perf.virtual-list@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.perf.virtual-list: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.derived-state@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family fe.state.derived-state: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.form-state@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family fe.state.form-state: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.immutable-updates@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family fe.state.immutable-updates@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.state.immutable-updates: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.list-keys@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.state.list-keys@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.state.list-keys: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.optimistic-updates@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.state.optimistic-updates: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.reducer-trace@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family fe.state.reducer-trace@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.state.reducer-trace: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.rerender-memo@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.state.rerender-memo@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.state.rerender-memo: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.signals@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.state.signals@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.state.signals: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.stale-closures@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family fe.state.stale-closures@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.state.stale-closures: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.state.state-machine@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family fe.state.state-machine@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.state.state-machine: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.cdn-cache@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.web.cdn-cache: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.cookies@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.web.cookies: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.cors@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.web.cors@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family fe.web.cors: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.credentialed-requests@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.web.credentialed-requests: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.csp@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.web.csp: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.http-cache@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family fe.web.http-cache@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.web.http-cache: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.service-worker-cache@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family fe.web.service-worker-cache: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family fe.web.url-resolution@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family fe.web.url-resolution: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.arch.context-leaks@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.arch.context-leaks: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.arch.di-scopes@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.arch.di-scopes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.arch.module-graph@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.arch.module-graph@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.arch.module-graph: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.arch.mvi-reducer@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.arch.mvi-reducer: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.arch.navigation-backstack@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.arch.navigation-backstack: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.code.chat-list@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family mob.code.chat-list@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family mob.code.chat-list: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.code.screen-reducer@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family mob.code.screen-reducer@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family mob.code.screen-reducer: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.cancellation@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.coroutines.cancellation@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.cancellation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.channels@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.coroutines.channels: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.delay-timeline@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.coroutines.delay-timeline@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.delay-timeline: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.exceptions@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.coroutines.exceptions@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.exceptions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.flow-operators@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.coroutines.flow-operators@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.flow-operators: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.launch-order@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.coroutines.launch-order@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.launch-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.scope-defects@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.coroutines.scope-defects@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.scope-defects: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.state-flow@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.state-flow: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.coroutines.timeouts@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.coroutines.timeouts: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.json-mapping@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family mob.data.json-mapping: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.local-cache-ttl@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family mob.data.local-cache-ttl: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.migrations@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.data.migrations@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.data.migrations: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.offline-cache@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.data.offline-cache@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.data.offline-cache: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.paging@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.data.paging@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.data.paging: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.room-queries@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.data.room-queries@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.data.room-queries: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.sync-conflicts@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.data.sync-conflicts@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.data.sync-conflicts: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.upsert-conflict@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.data.upsert-conflict@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.data.upsert-conflict: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.data.work-retry@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.data.work-retry@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.data.work-retry: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.collections@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.kotlin.collections@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.kotlin.collections: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.data-classes@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.kotlin.data-classes@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.kotlin.data-classes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.delegation-extensions@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.kotlin.delegation-extensions@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.kotlin.delegation-extensions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.equality-defects@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.kotlin.equality-defects@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.kotlin.equality-defects: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.lambdas-returns@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.kotlin.lambdas-returns@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.kotlin.lambdas-returns: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.null-defects@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.kotlin.null-defects@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.kotlin.null-defects: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.null-safety@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.kotlin.null-safety@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.kotlin.null-safety: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.scope-functions@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.kotlin.scope-functions@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.kotlin.scope-functions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.sequences@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.kotlin.sequences@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.kotlin.sequences: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.strings-ranges@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.65)
- (awaiting_reviews) family mob.kotlin.strings-ranges: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.kotlin.when-sealed@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.65)
- (awaiting_reviews) family mob.kotlin.when-sealed: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.activity-callbacks@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.lifecycle.activity-callbacks@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.lifecycle.activity-callbacks: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.config-change@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.lifecycle.config-change@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.lifecycle.config-change: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.fragment-callbacks@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.lifecycle.fragment-callbacks@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.lifecycle.fragment-callbacks: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.launch-modes@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.lifecycle.launch-modes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.observer-events@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.lifecycle.observer-events@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.lifecycle.observer-events: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.process-death@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.lifecycle.process-death@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.lifecycle.process-death: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.repeat-on-lifecycle@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.lifecycle.repeat-on-lifecycle@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.lifecycle.repeat-on-lifecycle: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.state-survival@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.lifecycle.state-survival@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.lifecycle.state-survival: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.lifecycle.two-activities@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.lifecycle.two-activities@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.lifecycle.two-activities: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.frame-budget@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.ui.frame-budget: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.layout-measure@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.ui.layout-measure@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.ui.layout-measure: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.list-diff@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.ui.list-diff@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.ui.list-diff: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.recomposition@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family mob.ui.recomposition@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.ui.recomposition: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.remember-state@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.ui.remember-state@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family mob.ui.remember-state: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.side-effects@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.ui.side-effects: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.state-hoisting@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family mob.ui.state-hoisting@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family mob.ui.state-hoisting: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family mob.ui.touch-dispatch@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family mob.ui.touch-dispatch@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family mob.ui.touch-dispatch: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.code.auc-ranking@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ds.code.auc-ranking@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ds.code.auc-ranking: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.code.classification-report@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ds.code.classification-report@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ds.code.classification-report: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.code.group-kfold@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ds.code.group-kfold@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ds.code.group-kfold: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.code.impute-scale@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ds.code.impute-scale@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ds.code.impute-scale: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.binning@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.data.binning@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.binning: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.dedup-sort@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.data.dedup-sort@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.dedup-sort: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.groupby-agg@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.data.groupby-agg@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.groupby-agg: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.join-rows@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.data.join-rows@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.join-rows: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.missing-values@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.data.missing-values@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.missing-values: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.pipeline-bug@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.data.pipeline-bug@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.pipeline-bug: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.split-leakage@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.split-leakage: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.target-encoding@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.target-encoding: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.data.window-ops@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.data.window-ops@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.data.window-ops: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.dl.attention-params@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.dl.attention-params: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.dl.backprop@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.dl.backprop: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.dl.conv-shapes@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.dl.conv-shapes@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.dl.conv-shapes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.dl.drift-impact@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.dl.drift-impact: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.dl.drift-psi@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.dl.drift-psi: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.dl.optimizer-step@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.dl.optimizer-step: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.baseline@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.metrics.baseline@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.metrics.baseline: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.confusion@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.metrics.confusion@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ds.metrics.confusion: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.logloss-calibration@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.metrics.logloss-calibration@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.metrics.logloss-calibration: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.metric-bug@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.metrics.metric-bug@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.metrics.metric-bug: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.multiclass-averaging@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.metrics.multiclass-averaging@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.metrics.multiclass-averaging: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.precision-at-k@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.metrics.precision-at-k@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.metrics.precision-at-k: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.ranking-ndcg@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.metrics.ranking-ndcg@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.metrics.ranking-ndcg: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.regression@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.metrics.regression@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ds.metrics.regression: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.roc-auc@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.metrics.roc-auc@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.metrics.roc-auc: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.metrics.threshold-cost@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.metrics.threshold-cost@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.metrics.threshold-cost: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.cv-split@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.ml.cv-split@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.ml.cv-split: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.early-stopping@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.ml.early-stopping@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.ml.early-stopping: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.leakage-locate@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.ml.leakage-locate@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.ml.leakage-locate: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.logreg-step@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.ml.logreg-step@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.ml.logreg-step: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.offline-online@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.ml.offline-online: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.prior-shift@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.ml.prior-shift@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.ml.prior-shift: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.scaler-leak@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.ml.scaler-leak@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.ml.scaler-leak: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.temporal-validation@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.ml.temporal-validation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.ml.tree-split@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ds.ml.tree-split: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.ab-metrics@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.sql.ab-metrics: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.agg-nulls@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.sql.agg-nulls@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ds.sql.agg-nulls: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.case-buckets@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.sql.case-buckets@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ds.sql.case-buckets: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.cohort-retention@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.sql.cohort-retention@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.sql.cohort-retention: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.funnel@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.sql.funnel@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.sql.funnel: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.gaps-islands@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.sql.gaps-islands: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.running-window@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.sql.running-window@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.sql.running-window: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.sql.top-per-group@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.sql.top-per-group@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ds.sql.top-per-group: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.ab-ztest@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.stats.ab-ztest@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.ab-ztest: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.bayes@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.stats.bayes@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.bayes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.binomial@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.stats.binomial@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.binomial: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.confidence-interval@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.stats.confidence-interval@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.confidence-interval: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.descriptive@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.stats.descriptive@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.descriptive: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.multiple-testing@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.stats.multiple-testing@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.multiple-testing: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.power@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.stats.power@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.stats.power: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.quantiles@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.stats.quantiles@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.quantiles: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.sampling@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ds.stats.sampling@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.sampling: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.simpson@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ds.stats.simpson@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ds.stats.simpson: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ds.stats.variance-reduction@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ds.stats.variance-reduction@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ds.stats.variance-reduction: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.breaking-changes@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.api.breaking-changes@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.api.breaking-changes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.conditional-requests@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.api.conditional-requests@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.api.conditional-requests: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.idempotent-create@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.api.idempotent-create@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.api.idempotent-create: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.pagination-drift@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.api.pagination-drift@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.api.pagination-drift: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.rate-limit@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.api.rate-limit@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.api.rate-limit: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.response-body@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.api.response-body@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.api.response-body: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.schema-violations@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.api.schema-violations@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.api.schema-violations: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.api.status-codes@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.65)
- (awaiting_raters) family qa.api.status-codes@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.api.status-codes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.cleanup-order@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family qa.auto.cleanup-order@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family qa.auto.cleanup-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.flaky-locate@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.auto.flaky-locate@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.auto.flaky-locate: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.mock-behaviour@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.auto.mock-behaviour: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.patch-target@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.auto.patch-target@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.auto.patch-target: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.polling-wait@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.auto.polling-wait@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.auto.polling-wait: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.result-summary@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.auto.result-summary: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.shared-state-order@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.auto.shared-state-order@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.auto.shared-state-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.unittest-lifecycle@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.auto.unittest-lifecycle: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.auto.vacuous-assertion@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family qa.auto.vacuous-assertion: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.bisect-first-bad@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.65)
- (awaiting_raters) family qa.defects.bisect-first-bad@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.bisect-first-bad: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.distributed-trace@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.defects.distributed-trace@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.distributed-trace: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.failing-cases@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.defects.failing-cases@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.failing-cases: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.flaky-order@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.defects.flaky-order@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.flaky-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.log-deviation@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.defects.log-deviation@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.log-deviation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.race-log@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.defects.race-log@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.race-log: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.spec-mismatch@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.defects.spec-mismatch@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.defects.spec-mismatch: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.stateful-bug@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.defects.stateful-bug@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.stateful-bug: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.defects.trace-localize@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.defects.trace-localize@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.defects.trace-localize: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.boundary-values@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.design.boundary-values@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.design.boundary-values: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.coverage-criteria@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.design.coverage-criteria@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.coverage-criteria: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.date-boundaries@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.design.date-boundaries@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.date-boundaries: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.decision-table@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.design.decision-table@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.decision-table: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.dependent-boundaries@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.design.dependent-boundaries@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.dependent-boundaries: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.equivalence-partitions@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.design.equivalence-partitions@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.equivalence-partitions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.mcdc@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.design.mcdc@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.mcdc: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.pairwise-constraints@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.design.pairwise-constraints@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.pairwise-constraints: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.pairwise-count@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.65)
- (awaiting_raters) family qa.design.pairwise-count@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.pairwise-count: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.state-transitions@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.65)
- (awaiting_raters) family qa.design.state-transitions@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.design.state-transitions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.design.transition-coverage@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family qa.design.transition-coverage@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.design.transition-coverage: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.mutants.api-access@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family qa.mutants.api-access@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family qa.mutants.api-access: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.mutants.field-validation@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family qa.mutants.field-validation@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family qa.mutants.field-validation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.mutants.order-lifecycle@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family qa.mutants.order-lifecycle@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family qa.mutants.order-lifecycle: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.mutants.pricing-rules@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family qa.mutants.pricing-rules@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family qa.mutants.pricing-rules: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.sql.null-traps@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.sql.null-traps@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.sql.null-traps: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.sql.orphans-duplicates@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.sql.orphans-duplicates@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.sql.orphans-duplicates: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.sql.reconciliation@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.sql.reconciliation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.sql.window-invariants@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.sql.window-invariants: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.strategy.change-impact@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.strategy.change-impact: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.strategy.exit-criteria@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.strategy.exit-criteria: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.strategy.parallel-shards@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.strategy.parallel-shards: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.strategy.requirements-traceability@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family qa.strategy.requirements-traceability: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family qa.strategy.risk-based-selection@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family qa.strategy.risk-based-selection@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family qa.strategy.risk-based-selection: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.cicd.artifacts-cache@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.cicd.artifacts-cache@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.cicd.artifacts-cache: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.cicd.deploy-concurrency@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.cicd.deploy-concurrency: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.cicd.matrix@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.cicd.matrix@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.cicd.matrix: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.cicd.needs-graph@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.cicd.needs-graph@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.cicd.needs-graph: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.cicd.pipeline-defect@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.cicd.pipeline-defect@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.cicd.pipeline-defect: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.cicd.trigger-rules@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.cicd.trigger-rules@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.cicd.trigger-rules: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.cicd.workflow-triggers@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.cicd.workflow-triggers@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.cicd.workflow-triggers: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.code.alert-engine@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ops.code.alert-engine@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ops.code.alert-engine: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.code.config-lint@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ops.code.config-lint@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ops.code.config-lint: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.code.log-stats@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ops.code.log-stats@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ops.code.log-stats: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.code.retry-planner@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family ops.code.retry-planner@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family ops.code.retry-planner: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.containers.build-context@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.containers.build-context: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.containers.dockerfile-defect@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.containers.dockerfile-defect@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.containers.dockerfile-defect: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.containers.entrypoint-cmd@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.containers.entrypoint-cmd@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.containers.entrypoint-cmd: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.containers.image-size@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.containers.image-size@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.containers.image-size: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.containers.layer-cache@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.containers.layer-cache@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.containers.layer-cache: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.containers.multi-stage@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.containers.multi-stage@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.containers.multi-stage: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.containers.run-options@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.containers.run-options@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.containers.run-options: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.iac.apply-order@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.iac.apply-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.iac.count-for-each@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.iac.count-for-each: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.iac.lifecycle@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.iac.lifecycle: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.iac.plan-actions@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.iac.plan-actions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.iac.variable-precedence@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.iac.variable-precedence: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.disruption-drain@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.disruption-drain: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.hpa-replicas@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.hpa-replicas: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.label-selectors@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.k8s.label-selectors@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.label-selectors: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.manifest-defect@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.k8s.manifest-defect@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.manifest-defect: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.network-policy@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.network-policy: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.probes-timeline@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.k8s.probes-timeline@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ops.k8s.probes-timeline: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.qos-classes@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.k8s.qos-classes@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.qos-classes: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.quota-limits@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.quota-limits: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.rolling-update@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.k8s.rolling-update@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ops.k8s.rolling-update: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.k8s.scheduling@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.k8s.scheduling@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.k8s.scheduling: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.exit-status@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.linux.exit-status@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.linux.exit-status: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.find-glob@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.linux.find-glob: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.log-pipeline@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.linux.log-pipeline@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.linux.log-pipeline: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.permissions@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.linux.permissions@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.linux.permissions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.redirections@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.linux.redirections@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ops.linux.redirections: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.script-defect@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.linux.script-defect@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.linux.script-defect: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.signals-traps@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ops.linux.signals-traps@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ops.linux.signals-traps: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.linux.text-fields@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.linux.text-fields@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.linux.text-fields: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.net.dns-resolve@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.net.dns-resolve@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.net.dns-resolve: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.net.firewall-chain@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ops.net.firewall-chain@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ops.net.firewall-chain: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.net.listen-reach@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.net.listen-reach@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.net.listen-reach: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.net.load-balancer@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ops.net.load-balancer@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.net.load-balancer: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.net.route-select@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.net.route-select@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.net.route-select: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.net.subnet-membership@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.net.subnet-membership@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family ops.net.subnet-membership: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.net.subnet-plan@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.net.subnet-plan@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.net.subnet-plan: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.observability.alert-pending@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.observability.alert-pending@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.observability.alert-pending: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.observability.availability-math@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.observability.availability-math@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.observability.availability-math: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.observability.burn-rate@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family ops.observability.burn-rate@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family ops.observability.burn-rate: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.observability.error-budget@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.observability.error-budget@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.observability.error-budget: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.observability.incident-timeline@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family ops.observability.incident-timeline@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.observability.incident-timeline: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family ops.observability.promql-eval@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family ops.observability.promql-eval@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family ops.observability.promql-eval: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources

## Выпуск и вместимость

### backend

| Грейд  | be.lang | be.algo | be.db | be.api | be.concurrency | be.debug | be.design | be.code |
| ------ | ------- | ------- | ----- | ------ | -------------- | -------- | --------- | ------- |
| intern | 5 / 5   | 4 / 3   | 5 / 4 | 1 / 1  | —              | 4 / 4    | —         | 2 / 1   |
| junior | 4 / 4   | 4 / 3   | 5 / 4 | 5 / 3  | —              | 4 / 3    | —         | 2 / 1   |
| middle | 2 / 2   | 2 / 2   | 5 / 4 | 4 / 3  | 5 / 3          | 4 / 3    | —         | 2 / 1   |
| senior | —       | —       | 4 / 3 | 4 / 3  | 5 / 4          | 2 / 2    | 5 / 5     | 2 / 1   |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                     | Итог | Нехватка |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                           | ok   |          |
| intern | A14                                                                                                                          | ok   |          |
| intern | A18 → B18 → block:be.lang → block:be.algo → block:be.db → block:be.debug → recheck:be.lang → recheck:be.db                   | ok   |          |
| intern | B6                                                                                                                           | ok   |          |
| intern | B14                                                                                                                          | ok   |          |
| intern | B18 → A18 → block:be.lang → block:be.algo → block:be.db → block:be.debug → recheck:be.lang → recheck:be.db                   | ok   |          |
| junior | A6                                                                                                                           | ok   |          |
| junior | A14                                                                                                                          | ok   |          |
| junior | A18 → B18 → block:be.lang → block:be.algo → block:be.db → block:be.api → block:be.debug → recheck:be.db → recheck:be.api     | ok   |          |
| junior | B6                                                                                                                           | ok   |          |
| junior | B14                                                                                                                          | ok   |          |
| junior | B18 → A18 → block:be.lang → block:be.algo → block:be.db → block:be.api → block:be.debug → recheck:be.db → recheck:be.api     | ok   |          |
| middle | A6                                                                                                                           | ok   |          |
| middle | A14                                                                                                                          | ok   |          |
| middle | A18 → B18 → block:be.db → block:be.api → block:be.concurrency → block:be.debug → recheck:be.db → recheck:be.concurrency      | ok   |          |
| middle | B6                                                                                                                           | ok   |          |
| middle | B14                                                                                                                          | ok   |          |
| middle | B18 → A18 → block:be.db → block:be.api → block:be.concurrency → block:be.debug → recheck:be.db → recheck:be.concurrency      | ok   |          |
| senior | A6                                                                                                                           | ok   |          |
| senior | A14                                                                                                                          | ok   |          |
| senior | A18 → B18 → block:be.db → block:be.api → block:be.concurrency → block:be.design → recheck:be.concurrency → recheck:be.design | ok   |          |
| senior | B6                                                                                                                           | ok   |          |
| senior | B14                                                                                                                          | ok   |          |
| senior | B18 → A18 → block:be.db → block:be.api → block:be.concurrency → block:be.design → recheck:be.concurrency → recheck:be.design | ok   |          |

Проблем выпуска нет.

### frontend

| Грейд  | fe.js | fe.async | fe.dom | fe.state | fe.web | fe.perf | fe.code |
| ------ | ----- | -------- | ------ | -------- | ------ | ------- | ------- |
| intern | 6 / 6 | 4 / 4    | 5 / 4  | 4 / 3    | —      | —       | 2 / 1   |
| junior | 7 / 4 | 5 / 4    | 6 / 3  | 4 / 3    | 4 / 3  | —       | 2 / 1   |
| middle | 4 / 3 | 6 / 4    | 2 / 2  | 5 / 4    | 2 / 2  | 2 / 2   | 2 / 1   |
| senior | 2 / 2 | 5 / 4    | —      | 4 / 3    | 4 / 3  | 5 / 5   | 2 / 1   |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                   | Итог | Нехватка |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                         | ok   |          |
| intern | A14                                                                                                                        | ok   |          |
| intern | A18 → B18 → block:fe.js → block:fe.async → block:fe.dom → block:fe.state → recheck:fe.js → recheck:fe.dom                  | ok   |          |
| intern | B6                                                                                                                         | ok   |          |
| intern | B14                                                                                                                        | ok   |          |
| intern | B18 → A18 → block:fe.js → block:fe.async → block:fe.dom → block:fe.state → recheck:fe.js → recheck:fe.dom                  | ok   |          |
| junior | A6                                                                                                                         | ok   |          |
| junior | A14                                                                                                                        | ok   |          |
| junior | A18 → B18 → block:fe.js → block:fe.async → block:fe.dom → block:fe.state → block:fe.web → recheck:fe.js → recheck:fe.async | ok   |          |
| junior | B6                                                                                                                         | ok   |          |
| junior | B14                                                                                                                        | ok   |          |
| junior | B18 → A18 → block:fe.js → block:fe.async → block:fe.dom → block:fe.state → block:fe.web → recheck:fe.js → recheck:fe.async | ok   |          |
| middle | A6                                                                                                                         | ok   |          |
| middle | A14                                                                                                                        | ok   |          |
| middle | A18 → B18 → block:fe.js → block:fe.async → block:fe.state → recheck:fe.async → recheck:fe.state                            | ok   |          |
| middle | B6                                                                                                                         | ok   |          |
| middle | B14                                                                                                                        | ok   |          |
| middle | B18 → A18 → block:fe.js → block:fe.async → block:fe.state → recheck:fe.async → recheck:fe.state                            | ok   |          |
| senior | A6                                                                                                                         | ok   |          |
| senior | A14                                                                                                                        | ok   |          |
| senior | A18 → B18 → block:fe.async → block:fe.state → block:fe.web → block:fe.perf → recheck:fe.async → recheck:fe.perf            | ok   |          |
| senior | B6                                                                                                                         | ok   |          |
| senior | B14                                                                                                                        | ok   |          |
| senior | B18 → A18 → block:fe.async → block:fe.state → block:fe.web → block:fe.perf → recheck:fe.async → recheck:fe.perf            | ok   |          |

Проблем выпуска нет.

### mobile

| Грейд  | mob.kotlin | mob.coroutines | mob.lifecycle | mob.ui | mob.data | mob.arch | mob.code |
| ------ | ---------- | -------------- | ------------- | ------ | -------- | -------- | -------- |
| intern | 7 / 7      | —              | 5 / 3         | 4 / 4  | 4 / 3    | —        | 1 / 1    |
| junior | 6 / 5      | 4 / 3          | 6 / 4         | 6 / 3  | 3 / 2    | —        | 1 / 1    |
| middle | 4 / 3      | 6 / 4          | 4 / 3         | 4 / 3  | 5 / 3    | 1 / 1    | 1 / 1    |
| senior | 3 / 2      | 5 / 4          | 2 / 2         | —      | 4 / 4    | 5 / 5    | 1 / 1    |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                                              | Итог | Нехватка |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                                                    | ok   |          |
| intern | A14                                                                                                                                                   | ok   |          |
| intern | A18 → B18 → block:mob.kotlin → block:mob.lifecycle → block:mob.ui → block:mob.data → recheck:mob.kotlin → recheck:mob.lifecycle                       | ok   |          |
| intern | B6                                                                                                                                                    | ok   |          |
| intern | B14                                                                                                                                                   | ok   |          |
| intern | B18 → A18 → block:mob.kotlin → block:mob.lifecycle → block:mob.ui → block:mob.data → recheck:mob.kotlin → recheck:mob.lifecycle                       | ok   |          |
| junior | A6                                                                                                                                                    | ok   |          |
| junior | A14                                                                                                                                                   | ok   |          |
| junior | A18 → B18 → block:mob.kotlin → block:mob.coroutines → block:mob.lifecycle → block:mob.ui → recheck:mob.kotlin → recheck:mob.lifecycle                 | ok   |          |
| junior | B6                                                                                                                                                    | ok   |          |
| junior | B14                                                                                                                                                   | ok   |          |
| junior | B18 → A18 → block:mob.kotlin → block:mob.coroutines → block:mob.lifecycle → block:mob.ui → recheck:mob.kotlin → recheck:mob.lifecycle                 | ok   |          |
| middle | A6                                                                                                                                                    | ok   |          |
| middle | A14                                                                                                                                                   | ok   |          |
| middle | A18 → B18 → block:mob.kotlin → block:mob.coroutines → block:mob.lifecycle → block:mob.ui → block:mob.data → recheck:mob.coroutines → recheck:mob.data | ok   |          |
| middle | B6                                                                                                                                                    | ok   |          |
| middle | B14                                                                                                                                                   | ok   |          |
| middle | B18 → A18 → block:mob.kotlin → block:mob.coroutines → block:mob.lifecycle → block:mob.ui → block:mob.data → recheck:mob.coroutines → recheck:mob.data | ok   |          |
| senior | A6                                                                                                                                                    | ok   |          |
| senior | A14                                                                                                                                                   | ok   |          |
| senior | A18 → B18 → block:mob.coroutines → block:mob.data → block:mob.arch → recheck:mob.coroutines → recheck:mob.arch                                        | ok   |          |
| senior | B6                                                                                                                                                    | ok   |          |
| senior | B14                                                                                                                                                   | ok   |          |
| senior | B18 → A18 → block:mob.coroutines → block:mob.data → block:mob.arch → recheck:mob.coroutines → recheck:mob.arch                                        | ok   |          |

Проблем выпуска нет.

### data_ml

| Грейд  | ds.stats | ds.metrics | ds.data | ds.ml | ds.sql | ds.dl | ds.code |
| ------ | -------- | ---------- | ------- | ----- | ------ | ----- | ------- |
| intern | 6 / 5    | 6 / 4      | 5 / 5   | —     | 4 / 3  | —     | 2 / 1   |
| junior | 7 / 3    | 7 / 4      | 7 / 4   | 4 / 3 | 6 / 3  | —     | 2 / 1   |
| middle | 5 / 3    | 4 / 3      | 4 / 3   | 6 / 5 | 2 / 2  | 1 / 1 | 2 / 1   |
| senior | 4 / 3    | 3 / 2      | —       | 5 / 5 | 2 / 2  | 6 / 5 | 2 / 1   |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                          | Итог | Нехватка |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                                | ok   |          |
| intern | A14                                                                                                                               | ok   |          |
| intern | A18 → B18 → block:ds.stats → block:ds.metrics → block:ds.data → block:ds.sql → recheck:ds.stats → recheck:ds.metrics              | ok   |          |
| intern | B6                                                                                                                                | ok   |          |
| intern | B14                                                                                                                               | ok   |          |
| intern | B18 → A18 → block:ds.stats → block:ds.metrics → block:ds.data → block:ds.sql → recheck:ds.stats → recheck:ds.metrics              | ok   |          |
| junior | A6                                                                                                                                | ok   |          |
| junior | A14                                                                                                                               | ok   |          |
| junior | A18 → B18 → block:ds.stats → block:ds.metrics → block:ds.data → block:ds.ml → block:ds.sql → recheck:ds.metrics → recheck:ds.data | ok   |          |
| junior | B6                                                                                                                                | ok   |          |
| junior | B14                                                                                                                               | ok   |          |
| junior | B18 → A18 → block:ds.stats → block:ds.metrics → block:ds.data → block:ds.ml → block:ds.sql → recheck:ds.metrics → recheck:ds.data | ok   |          |
| middle | A6                                                                                                                                | ok   |          |
| middle | A14                                                                                                                               | ok   |          |
| middle | A18 → B18 → block:ds.stats → block:ds.metrics → block:ds.data → block:ds.ml → recheck:ds.ml → recheck:ds.stats                    | ok   |          |
| middle | B6                                                                                                                                | ok   |          |
| middle | B14                                                                                                                               | ok   |          |
| middle | B18 → A18 → block:ds.stats → block:ds.metrics → block:ds.data → block:ds.ml → recheck:ds.ml → recheck:ds.stats                    | ok   |          |
| senior | A6                                                                                                                                | ok   |          |
| senior | A14                                                                                                                               | ok   |          |
| senior | A18 → B18 → block:ds.stats → block:ds.ml → block:ds.dl → recheck:ds.ml → recheck:ds.dl                                            | ok   |          |
| senior | B6                                                                                                                                | ok   |          |
| senior | B14                                                                                                                               | ok   |          |
| senior | B18 → A18 → block:ds.stats → block:ds.ml → block:ds.dl → recheck:ds.ml → recheck:ds.dl                                            | ok   |          |

Проблем выпуска нет.

### qa

| Грейд  | qa.design | qa.defects | qa.api | qa.auto | qa.sql | qa.strategy | qa.mutants |
| ------ | --------- | ---------- | ------ | ------- | ------ | ----------- | ---------- |
| intern | 6 / 6     | 5 / 5      | 4 / 4  | —       | 2 / 2  | —           | 2 / 1      |
| junior | 6 / 5     | 5 / 4      | 4 / 3  | 4 / 3   | 2 / 2  | —           | 2 / 1      |
| middle | 5 / 4     | 4 / 3      | 4 / 3  | 5 / 4   | 2 / 2  | 1 / 1       | 2 / 1      |
| senior | 5 / 3     | 4 / 3      | 4 / 2  | 5 / 4   | —      | 5 / 5       | 2 / 1      |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                   | Итог | Нехватка |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                         | ok   |          |
| intern | A14                                                                                                                        | ok   |          |
| intern | A18 → B18 → block:qa.design → block:qa.defects → block:qa.api → recheck:qa.design → recheck:qa.defects                     | ok   |          |
| intern | B6                                                                                                                         | ok   |          |
| intern | B14                                                                                                                        | ok   |          |
| intern | B18 → A18 → block:qa.design → block:qa.defects → block:qa.api → recheck:qa.design → recheck:qa.defects                     | ok   |          |
| junior | A6                                                                                                                         | ok   |          |
| junior | A14                                                                                                                        | ok   |          |
| junior | A18 → B18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.design → recheck:qa.defects     | ok   |          |
| junior | B6                                                                                                                         | ok   |          |
| junior | B14                                                                                                                        | ok   |          |
| junior | B18 → A18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.design → recheck:qa.defects     | ok   |          |
| middle | A6                                                                                                                         | ok   |          |
| middle | A14                                                                                                                        | ok   |          |
| middle | A18 → B18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.auto → recheck:qa.design        | ok   |          |
| middle | B6                                                                                                                         | ok   |          |
| middle | B14                                                                                                                        | ok   |          |
| middle | B18 → A18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.auto → recheck:qa.design        | ok   |          |
| senior | A6                                                                                                                         | ok   |          |
| senior | A14                                                                                                                        | ok   |          |
| senior | A18 → B18 → block:qa.design → block:qa.defects → block:qa.auto → block:qa.strategy → recheck:qa.strategy → recheck:qa.auto | ok   |          |
| senior | B6                                                                                                                         | ok   |          |
| senior | B14                                                                                                                        | ok   |          |
| senior | B18 → A18 → block:qa.design → block:qa.defects → block:qa.auto → block:qa.strategy → recheck:qa.strategy → recheck:qa.auto | ok   |          |

Проблем выпуска нет.

### devops

| Грейд  | ops.linux | ops.net | ops.containers | ops.k8s | ops.cicd | ops.observability | ops.iac | ops.code |
| ------ | --------- | ------- | -------------- | ------- | -------- | ----------------- | ------- | -------- |
| intern | 6 / 6     | 5 / 4   | 5 / 5          | —       | 2 / 2    | —                 | —       | 2 / 1    |
| junior | 7 / 4     | 5 / 3   | 6 / 4          | 6 / 3   | 5 / 3    | —                 | —       | 2 / 1    |
| middle | 2 / 2     | 2 / 2   | 2 / 2          | 6 / 4   | 4 / 3    | 6 / 4             | —       | 2 / 1    |
| senior | —         | 2 / 2   | —              | 4 / 4   | 2 / 2    | 6 / 4             | 5 / 5   | 2 / 1    |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                                       | Итог | Нехватка |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                                             | ok   |          |
| intern | A14                                                                                                                                            | ok   |          |
| intern | A18 → B18 → block:ops.linux → block:ops.net → block:ops.containers → recheck:ops.linux → recheck:ops.net                                       | ok   |          |
| intern | B6                                                                                                                                             | ok   |          |
| intern | B14                                                                                                                                            | ok   |          |
| intern | B18 → A18 → block:ops.linux → block:ops.net → block:ops.containers → recheck:ops.linux → recheck:ops.net                                       | ok   |          |
| junior | A6                                                                                                                                             | ok   |          |
| junior | A14                                                                                                                                            | ok   |          |
| junior | A18 → B18 → block:ops.linux → block:ops.net → block:ops.containers → block:ops.k8s → block:ops.cicd → recheck:ops.containers → recheck:ops.k8s | ok   |          |
| junior | B6                                                                                                                                             | ok   |          |
| junior | B14                                                                                                                                            | ok   |          |
| junior | B18 → A18 → block:ops.linux → block:ops.net → block:ops.containers → block:ops.k8s → block:ops.cicd → recheck:ops.containers → recheck:ops.k8s | ok   |          |
| middle | A6                                                                                                                                             | ok   |          |
| middle | A14                                                                                                                                            | ok   |          |
| middle | A18 → B18 → block:ops.k8s → block:ops.cicd → block:ops.observability → recheck:ops.k8s → recheck:ops.observability                             | ok   |          |
| middle | B6                                                                                                                                             | ok   |          |
| middle | B14                                                                                                                                            | ok   |          |
| middle | B18 → A18 → block:ops.k8s → block:ops.cicd → block:ops.observability → recheck:ops.k8s → recheck:ops.observability                             | ok   |          |
| senior | A6                                                                                                                                             | ok   |          |
| senior | A14                                                                                                                                            | ok   |          |
| senior | A18 → B18 → block:ops.k8s → block:ops.observability → block:ops.iac → recheck:ops.iac → recheck:ops.observability                              | ok   |          |
| senior | B6                                                                                                                                             | ok   |          |
| senior | B14                                                                                                                                            | ok   |          |
| senior | B18 → A18 → block:ops.k8s → block:ops.observability → block:ops.iac → recheck:ops.iac → recheck:ops.observability                              | ok   |          |

Проблем выпуска нет.
