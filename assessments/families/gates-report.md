# Отчёт ворот банка

Среда исполнения: образ песочницы `fsp-sandbox:test` — Python 3.13.15, SQLite 3.46.1. Сидов на класс: 200. Проверено семейств: 1, время 836 с.

## Семейства

| Семейство               | Формат        | Уровни         | Экз. | Эталон: отказов | Ошибочные: поймано | Коллизия | Пересечение классов | Мутанты (убито / всего − экв.) | Перенос | Проблем |
| ----------------------- | ------------- | -------------- | ---- | --------------- | ------------------ | -------- | ------------------- | ------------------------------ | ------- | ------- |
| `ops.code.alert-engine` | practice_code | middle, senior | 1600 | 0               | 7 / 7              | 0        | —                   | 1582 / 1656 − 69 = 0.9968      | 0.0013  | 0       |

## Ошибочные решения

- `ops.code.alert-engine`: for-strict — отвергнуто 1600 из 1600; pending-silent — отвергнуто 1600 из 1600; threshold-inclusive — отвергнуто 1200 из 1200; window-closed — отвергнуто 800 из 800; counter-reset-ignored — отвергнуто 400 из 400; no-staleness — отвергнуто 400 из 400; own-ticks — отвергнуто 600 из 600

## Проблемы ворот

Нет.

## Валидатор контракта

- (awaiting_raters) family be.algo.binary-search@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.algo.binary-search@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.algo.binary-search: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.algo.cache-eviction@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.algo.cache-eviction: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.algo.graph-traversal@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.algo.graph-traversal@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.algo.graph-traversal: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.algo.heap-dijkstra@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.algo.heap-dijkstra: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.algo.sorting-stability@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.algo.sorting-stability@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.algo.sorting-stability: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.algo.two-pointers@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.algo.two-pointers@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.algo.two-pointers: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.cors-preflight@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.api.cors-preflight@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.api.cors-preflight: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.http-caching@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.api.http-caching@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.api.http-caching: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.idempotency-keys@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.api.idempotency-keys@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.api.idempotency-keys: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.optimistic-locking@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.api.optimistic-locking: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.pagination-consistency@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.api.pagination-consistency@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.api.pagination-consistency: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.rest-semantics@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.api.rest-semantics: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.retry-backoff@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.api.retry-backoff@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.api.retry-backoff: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.webhook-delivery@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.api.webhook-delivery: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.api.webhook-signatures@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.api.webhook-signatures: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.code.order-summary@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family be.code.order-summary@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family be.code.order-summary: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.code.rate-limiter@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family be.code.rate-limiter@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family be.code.rate-limiter: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.code.sessionize@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family be.code.sessionize@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family be.code.sessionize: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.code.stock-reservations@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family be.code.stock-reservations@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family be.code.stock-reservations: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.concurrency.asyncio-order@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.concurrency.asyncio-order@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.concurrency.asyncio-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.concurrency.deadlock-detect@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.concurrency.deadlock-detect@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.concurrency.deadlock-detect: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.concurrency.lost-update@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.concurrency.lost-update@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.concurrency.lost-update: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.concurrency.queue-redelivery@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.concurrency.queue-redelivery@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.concurrency.queue-redelivery: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.concurrency.sync-primitives@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.concurrency.sync-primitives@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.concurrency.sync-primitives: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.case-coalesce@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family be.db.case-coalesce: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.filter-order@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family be.db.filter-order: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.group-having@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.db.group-having@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.db.group-having: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.isolation-anomalies@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.db.isolation-anomalies: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.join-multiplicity@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.db.join-multiplicity@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.db.join-multiplicity: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.null-aggregates@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.db.null-aggregates@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.db.null-aggregates: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.recursive-cte@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.db.recursive-cte@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.db.recursive-cte: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.subquery-exists@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.db.subquery-exists@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.db.subquery-exists: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.transactions-savepoint@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.db.transactions-savepoint@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.db.transactions-savepoint: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.upsert-conflict@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.db.upsert-conflict@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.db.upsert-conflict: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.db.window-functions@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.db.window-functions@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.db.window-functions: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.api-handlers@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.debug.api-handlers@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.debug.api-handlers: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.async-races@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.debug.async-races@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.debug.async-races: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.cache-invalidation@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.debug.cache-invalidation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.data-pipeline@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.debug.data-pipeline@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.debug.data-pipeline: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.input-validation@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.debug.input-validation@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.debug.input-validation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.money-dates@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family be.debug.money-dates: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.resource-timeouts@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.debug.resource-timeouts@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.debug.resource-timeouts: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.debug.spec-violation@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.debug.spec-violation@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.debug.spec-violation: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.design.cache-hit-ratio@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.design.cache-hit-ratio: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.design.capacity-estimate@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.design.capacity-estimate: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.design.circuit-breaker@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.design.circuit-breaker: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.design.queue-backlog@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.design.queue-backlog: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.design.quorum-consistency@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.design.quorum-consistency: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.lang.classes-mro@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.lang.classes-mro: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.lang.closure-capture@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.lang.closure-capture@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.lang.closure-capture: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.lang.collections-trace@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_reviews) family be.lang.collections-trace: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.lang.exceptions-flow@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_raters) family be.lang.exceptions-flow@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.lang.exceptions-flow: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.lang.generators-iterators@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_raters) family be.lang.generators-iterators@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.45)
- (awaiting_reviews) family be.lang.generators-iterators: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.lang.mutable-aliasing@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)
- (awaiting_raters) family be.lang.mutable-aliasing@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.5)
- (awaiting_reviews) family be.lang.mutable-aliasing: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.lang.numbers-strings@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.55)
- (awaiting_reviews) family be.lang.numbers-strings: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
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

Выжившие мутанты `ops.code.alert-engine`:

- middle/rate#1: line 35: const -> 2
- senior/threshold#0: line 7: const -> 0
- senior/rate#0: line 7: const -> 0
- senior/rate#1: line 7: const -> 0
- senior/rate#2: line 7: const -> 0
