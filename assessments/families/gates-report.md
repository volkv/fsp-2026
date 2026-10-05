# Отчёт ворот банка

Среда исполнения: образ песочницы `fsp-sandbox:test` — Python 3.13.15, SQLite 3.46.1. Сидов на класс: 200. Проверено семейств: 105, время 1055 с.

## Семейства

| Семейство                               | Формат        | Уровни         | Экз. | Эталон: отказов | Ошибочные: поймано | Коллизия | Пересечение классов | Мутанты (убито / всего − экв.) | Перенос | Проблем |
| --------------------------------------- | ------------- | -------------- | ---- | --------------- | ------------------ | -------- | ------------------- | ------------------------------ | ------- | ------- |
| `be.algo.binary-search`                 | code_trace    | intern, junior | 1600 | 0               | 10 / 10            | 0.0005   | 0                   | —                              | —       | 0       |
| `be.algo.cache-eviction`                | compute       | middle         | 800  | 0               | 7 / 7              | 0.0009   | 0                   | —                              | —       | 0       |
| `be.algo.graph-traversal`               | code_trace    | intern, junior | 1600 | 0               | 9 / 9              | 0.0025   | 0                   | —                              | —       | 0       |
| `be.algo.heap-dijkstra`                 | compute       | middle         | 800  | 0               | 5 / 5              | 0.0019   | 0.005               | —                              | —       | 0       |
| `be.algo.sorting-stability`             | code_trace    | intern, junior | 1600 | 0               | 11 / 11            | 0.0003   | 0                   | —                              | —       | 0       |
| `be.algo.two-pointers`                  | code_trace    | intern, junior | 1600 | 0               | 11 / 11            | 0.0099   | 0                   | —                              | —       | 0       |
| `be.api.cors-preflight`                 | compute       | junior, middle | 1600 | 0               | 9 / 9              | 0.0053   | 0.005               | —                              | —       | 0       |
| `be.api.http-caching`                   | compute       | junior, middle | 1600 | 0               | 13 / 13            | 0.0049   | 0                   | —                              | —       | 0       |
| `be.api.idempotency-keys`               | compute       | junior, middle | 1600 | 0               | 9 / 9              | 0.0002   | 0                   | —                              | —       | 0       |
| `be.api.optimistic-locking`             | compute       | senior         | 800  | 0               | 5 / 5              | 0        | 0                   | —                              | —       | 0       |
| `be.api.pagination-consistency`         | compute       | intern, junior | 1600 | 0               | 10 / 10            | 0.0027   | 0                   | —                              | —       | 0       |
| `be.api.rest-semantics`                 | compute       | junior         | 800  | 0               | 6 / 6              | 0        | 0                   | —                              | —       | 0       |
| `be.api.retry-backoff`                  | compute       | middle, senior | 1600 | 0               | 7 / 7              | 0.0009   | 0                   | —                              | —       | 0       |
| `be.api.webhook-delivery`               | compute       | senior         | 800  | 0               | 6 / 6              | 0        | 0                   | —                              | —       | 0       |
| `be.api.webhook-signatures`             | compute       | senior         | 800  | 0               | 6 / 6              | 0.0002   | 0                   | —                              | —       | 0       |
| `be.code.order-summary`                 | practice_code | intern, junior | 1600 | 0               | 6 / 6              | 0        | —                   | 498 / 519 − 21 = 1             | 0       | 0       |
| `be.code.rate-limiter`                  | practice_code | middle, senior | 1600 | 0               | 3 / 3              | 0        | —                   | 881 / 924 − 33 = 0.9888        | 0       | 0       |
| `be.code.sessionize`                    | practice_code | intern, junior | 1600 | 0               | 7 / 7              | 0        | —                   | 1413 / 1440 − 27 = 1           | 0       | 0       |
| `be.code.stock-reservations`            | practice_code | middle, senior | 1600 | 0               | 8 / 8              | 0        | —                   | 2055 / 2070 − 15 = 1           | 0       | 0       |
| `be.concurrency.asyncio-order`          | code_trace    | middle, senior | 1600 | 0               | 13 / 13            | 0.0007   | 0                   | —                              | —       | 0       |
| `be.concurrency.deadlock-detect`        | compute       | middle, senior | 1600 | 0               | 7 / 7              | 0.0021   | 0.005               | —                              | —       | 0       |
| `be.concurrency.lost-update`            | compute       | middle, senior | 1600 | 0               | 8 / 8              | 0.0101   | 0.005               | —                              | —       | 0       |
| `be.concurrency.queue-redelivery`       | compute       | middle, senior | 1600 | 0               | 11 / 11            | 0        | 0                   | —                              | —       | 0       |
| `be.concurrency.sync-primitives`        | code_trace    | middle, senior | 1600 | 0               | 10 / 10            | 0.0005   | 0                   | —                              | —       | 0       |
| `be.db.case-coalesce`                   | sql_trace     | intern         | 800  | 0               | 5 / 5              | 0        | 0                   | —                              | —       | 0       |
| `be.db.filter-order`                    | sql_trace     | intern         | 800  | 0               | 6 / 6              | 0        | 0                   | —                              | —       | 0       |
| `be.db.group-having`                    | sql_trace     | junior, middle | 1600 | 0               | 8 / 8              | 0        | 0                   | —                              | —       | 0       |
| `be.db.isolation-anomalies`             | compute       | senior         | 800  | 0               | 7 / 7              | 0.0003   | 0                   | —                              | —       | 0       |
| `be.db.join-multiplicity`               | sql_trace     | intern, junior | 1600 | 0               | 9 / 9              | 0.001    | 0                   | —                              | —       | 0       |
| `be.db.null-aggregates`                 | sql_trace     | intern, junior | 1600 | 0               | 6 / 6              | 0.0171   | 0                   | —                              | —       | 0       |
| `be.db.recursive-cte`                   | sql_trace     | middle, senior | 1600 | 0               | 10 / 10            | 0.0005   | 0                   | —                              | —       | 0       |
| `be.db.subquery-exists`                 | sql_trace     | intern, junior | 1600 | 0               | 8 / 8              | 0.0012   | 0                   | —                              | —       | 0       |
| `be.db.transactions-savepoint`          | sql_trace     | middle, senior | 1600 | 0               | 7 / 7              | 0        | 0                   | —                              | —       | 0       |
| `be.db.upsert-conflict`                 | sql_trace     | junior, middle | 1600 | 0               | 6 / 6              | 0        | 0                   | —                              | —       | 0       |
| `be.db.window-functions`                | sql_trace     | middle, senior | 1600 | 0               | 10 / 10            | 0        | 0                   | —                              | —       | 0       |
| `be.debug.api-handlers`                 | bug_locate    | junior, middle | 1600 | 0               | 2 / 2              | 0.0206   | 0.025               | —                              | —       | 0       |
| `be.debug.async-races`                  | bug_locate    | middle, senior | 1600 | 0               | 2 / 2              | 0.0247   | 0.03                | —                              | —       | 0       |
| `be.debug.cache-invalidation`           | bug_locate    | middle         | 800  | 0               | 2 / 2              | 0.0209   | 0.03                | —                              | —       | 0       |
| `be.debug.data-pipeline`                | bug_locate    | intern, junior | 1600 | 0               | 2 / 2              | 0.0216   | 0.025               | —                              | —       | 0       |
| `be.debug.input-validation`             | bug_locate    | intern, junior | 1600 | 0               | 2 / 2              | 0.0222   | 0.045               | —                              | —       | 0       |
| `be.debug.money-dates`                  | bug_locate    | intern         | 800  | 0               | 2 / 2              | 0.0305   | 0.05                | —                              | —       | 0       |
| `be.debug.resource-timeouts`            | bug_locate    | middle, senior | 1600 | 0               | 2 / 2              | 0.0255   | 0.04                | —                              | —       | 0       |
| `be.debug.spec-violation`               | bug_locate    | intern, junior | 1600 | 0               | 2 / 2              | 0.0312   | 0.035               | —                              | —       | 0       |
| `be.design.cache-hit-ratio`             | compute       | senior         | 800  | 0               | 6 / 6              | 0.0002   | 0                   | —                              | —       | 0       |
| `be.design.capacity-estimate`           | compute       | senior         | 800  | 0               | 7 / 7              | 0.0005   | 0                   | —                              | —       | 0       |
| `be.design.circuit-breaker`             | compute       | senior         | 800  | 0               | 6 / 6              | 0.0001   | 0                   | —                              | —       | 0       |
| `be.design.queue-backlog`               | compute       | senior         | 800  | 0               | 7 / 7              | 0.0062   | 0.01                | —                              | —       | 0       |
| `be.design.quorum-consistency`          | compute       | senior         | 800  | 0               | 6 / 6              | 0.0032   | 0.005               | —                              | —       | 0       |
| `be.lang.classes-mro`                   | code_trace    | middle         | 800  | 0               | 9 / 9              | 0.0006   | 0                   | —                              | —       | 0       |
| `be.lang.closure-capture`               | code_trace    | intern, junior | 1600 | 0               | 6 / 6              | 0.0144   | 0.02                | —                              | —       | 0       |
| `be.lang.collections-trace`             | code_trace    | intern         | 800  | 0               | 8 / 8              | 0.0001   | 0                   | —                              | —       | 0       |
| `be.lang.exceptions-flow`               | code_trace    | intern, junior | 1600 | 0               | 16 / 16            | 0.0012   | 0                   | —                              | —       | 0       |
| `be.lang.generators-iterators`          | code_trace    | junior, middle | 1600 | 0               | 16 / 16            | 0.001    | 0                   | —                              | —       | 0       |
| `be.lang.mutable-aliasing`              | code_trace    | intern, junior | 1600 | 0               | 13 / 13            | 0        | 0                   | —                              | —       | 0       |
| `be.lang.numbers-strings`               | code_trace    | intern         | 800  | 0               | 7 / 7              | 0.0005   | 0                   | —                              | —       | 0       |
| `qa.api.breaking-changes`               | compute       | middle, senior | 1600 | 0               | 9 / 9              | 0.0119   | 0.015               | —                              | —       | 0       |
| `qa.api.conditional-requests`           | compute       | middle, senior | 1600 | 0               | 9 / 9              | 0.0156   | 0                   | —                              | —       | 0       |
| `qa.api.idempotent-create`              | compute       | intern, junior | 1600 | 0               | 9 / 9              | 0.0001   | 0                   | —                              | —       | 0       |
| `qa.api.pagination-drift`               | compute       | middle, senior | 1600 | 0               | 6 / 6              | 0.0167   | 0.01                | —                              | —       | 0       |
| `qa.api.rate-limit`                     | compute       | middle, senior | 1600 | 0               | 9 / 9              | 0.0064   | 0                   | —                              | —       | 0       |
| `qa.api.response-body`                  | compute       | intern, junior | 1600 | 0               | 9 / 9              | 0.0001   | 0                   | —                              | —       | 0       |
| `qa.api.schema-violations`              | compute       | intern, junior | 1600 | 0               | 10 / 10            | 0.0083   | 0.02                | —                              | —       | 0       |
| `qa.api.status-codes`                   | compute       | intern, junior | 1600 | 0               | 9 / 9              | 0.0007   | 0                   | —                              | —       | 0       |
| `qa.auto.cleanup-order`                 | code_trace    | middle, senior | 1600 | 0               | 19 / 19            | 0.0001   | 0                   | —                              | —       | 0       |
| `qa.auto.flaky-locate`                  | bug_locate    | middle, senior | 1600 | 0               | 2 / 2              | 0.0372   | 0.035               | —                              | —       | 0       |
| `qa.auto.mock-behaviour`                | code_trace    | junior         | 800  | 0               | 12 / 12            | 0.0005   | 0                   | —                              | —       | 0       |
| `qa.auto.patch-target`                  | code_trace    | middle, senior | 1600 | 0               | 17 / 17            | 0.0011   | 0                   | —                              | —       | 0       |
| `qa.auto.polling-wait`                  | code_trace    | middle, senior | 1600 | 0               | 10 / 10            | 0.0154   | 0                   | —                              | —       | 0       |
| `qa.auto.result-summary`                | code_trace    | junior         | 800  | 0               | 10 / 10            | 0        | 0                   | —                              | —       | 0       |
| `qa.auto.shared-state-order`            | code_trace    | middle, senior | 1600 | 0               | 15 / 15            | 0        | 0                   | —                              | —       | 0       |
| `qa.auto.unittest-lifecycle`            | code_trace    | junior         | 800  | 0               | 10 / 10            | 0        | 0                   | —                              | —       | 0       |
| `qa.auto.vacuous-assertion`             | bug_locate    | junior         | 800  | 0               | 2 / 2              | 0.0342   | 0.055               | —                              | —       | 0       |
| `qa.defects.bisect-first-bad`           | compute       | intern, junior | 1600 | 0               | 10 / 10            | 0        | 0                   | —                              | —       | 0       |
| `qa.defects.distributed-trace`          | compute       | middle, senior | 1600 | 0               | 8 / 8              | 0.0216   | 0                   | —                              | —       | 0       |
| `qa.defects.failing-cases`              | compute       | intern, junior | 1600 | 0               | 3 / 3              | 0.0008   | 0                   | —                              | —       | 0       |
| `qa.defects.flaky-order`                | compute       | middle, senior | 1600 | 0               | 3 / 3              | 0.0104   | 0.01                | —                              | —       | 0       |
| `qa.defects.log-deviation`              | compute       | intern, junior | 1600 | 0               | 8 / 8              | 0        | 0                   | —                              | —       | 0       |
| `qa.defects.race-log`                   | compute       | middle, senior | 1600 | 0               | 3 / 3              | 0.0026   | 0                   | —                              | —       | 0       |
| `qa.defects.spec-mismatch`              | bug_locate    | intern, junior | 1600 | 0               | 2 / 2              | 0.0255   | 0.035               | —                              | —       | 0       |
| `qa.defects.stateful-bug`               | bug_locate    | middle, senior | 1600 | 0               | 2 / 2              | 0.0354   | 0.05                | —                              | —       | 0       |
| `qa.defects.trace-localize`             | compute       | intern, junior | 1600 | 0               | 3 / 3              | 0.0034   | 0                   | —                              | —       | 0       |
| `qa.design.boundary-values`             | compute       | intern, junior | 1600 | 0               | 7 / 7              | 0        | 0                   | —                              | —       | 0       |
| `qa.design.coverage-criteria`           | compute       | middle, senior | 1600 | 0               | 9 / 9              | 0.032    | 0.005               | —                              | —       | 0       |
| `qa.design.date-boundaries`             | compute       | intern, junior | 1600 | 0               | 12 / 12            | 0.0011   | 0                   | —                              | —       | 0       |
| `qa.design.decision-table`              | compute       | intern, junior | 1600 | 0               | 5 / 5              | 0.0062   | 0                   | —                              | —       | 0       |
| `qa.design.dependent-boundaries`        | compute       | middle, senior | 1600 | 0               | 9 / 9              | 0.0012   | 0                   | —                              | —       | 0       |
| `qa.design.equivalence-partitions`      | compute       | intern, junior | 1600 | 0               | 7 / 7              | 0.0137   | 0.01                | —                              | —       | 0       |
| `qa.design.mcdc`                        | compute       | middle, senior | 1600 | 0               | 5 / 5              | 0.0314   | 0                   | —                              | —       | 0       |
| `qa.design.pairwise-constraints`        | compute       | middle, senior | 1600 | 0               | 4 / 4              | 0.0163   | 0                   | —                              | —       | 0       |
| `qa.design.pairwise-count`              | compute       | intern, junior | 1600 | 0               | 8 / 8              | 0.0174   | 0.005               | —                              | —       | 0       |
| `qa.design.state-transitions`           | compute       | intern, junior | 1600 | 0               | 5 / 5              | 0.0144   | 0.02                | —                              | —       | 0       |
| `qa.design.transition-coverage`         | compute       | middle, senior | 1600 | 0               | 7 / 7              | 0.0285   | 0.01                | —                              | —       | 0       |
| `qa.mutants.api-access`                 | qa_mutation   | middle, senior | 1600 | 0               | 4 / 4              | 0.0009   | —                   | —                              | —       | 0       |
| `qa.mutants.field-validation`           | qa_mutation   | intern, junior | 1600 | 0               | 4 / 4              | 0.0092   | —                   | —                              | —       | 0       |
| `qa.mutants.order-lifecycle`            | qa_mutation   | middle, senior | 1600 | 0               | 4 / 4              | 0        | —                   | —                              | —       | 0       |
| `qa.mutants.pricing-rules`              | qa_mutation   | intern, junior | 1600 | 0               | 3 / 3              | 0        | —                   | —                              | —       | 0       |
| `qa.sql.null-traps`                     | sql_trace     | intern, junior | 1600 | 0               | 9 / 9              | 0        | 0                   | —                              | —       | 0       |
| `qa.sql.orphans-duplicates`             | sql_trace     | intern, junior | 1600 | 0               | 9 / 9              | 0.0027   | 0                   | —                              | —       | 0       |
| `qa.sql.reconciliation`                 | sql_trace     | middle         | 800  | 0               | 7 / 7              | 0        | 0                   | —                              | —       | 0       |
| `qa.sql.window-invariants`              | sql_trace     | middle         | 800  | 0               | 7 / 7              | 0.0001   | 0                   | —                              | —       | 0       |
| `qa.strategy.change-impact`             | compute       | senior         | 800  | 0               | 6 / 6              | 0.0006   | 0                   | —                              | —       | 0       |
| `qa.strategy.exit-criteria`             | compute       | senior         | 800  | 0               | 6 / 6              | 0.0174   | 0                   | —                              | —       | 0       |
| `qa.strategy.parallel-shards`           | compute       | senior         | 800  | 0               | 5 / 5              | 0        | 0                   | —                              | —       | 0       |
| `qa.strategy.requirements-traceability` | compute       | senior         | 800  | 0               | 4 / 4              | 0.0057   | 0                   | —                              | —       | 0       |
| `qa.strategy.risk-based-selection`      | compute       | middle, senior | 1600 | 0               | 8 / 8              | 0        | 0                   | —                              | —       | 0       |

## Ошибочные решения

- `be.algo.binary-search`: bound-swapped — отвергнуто 600 из 600; not-found-minus-one — отвергнуто 600 из 600; first-occurrence — отвергнуто 200 из 200; strict-capacity — отвергнуто 200 из 200; stop-at-feasible — отвергнуто 200 из 200; right-is-last-index — отвергнуто 200 из 200; rotation-blind — отвергнуто 200 из 200; hi-equals-lo — отвергнуто 200 из 200; last-is-first — отвергнуто 200 из 200; strict-bound — отвергнуто 200 из 200
- `be.algo.cache-eviction`: lru-no-refresh — отвергнуто 200 из 200; fifo-refresh — отвергнуто 200 из 200; lfu-tie-fifo — отвергнуто 200 из 200; lfu-keeps-history — отвергнуто 200 из 200; cold-misses-ignored — отвергнуто 800 из 800; clock-as-fifo — отвергнуто 200 из 200; clock-as-lru — отвергнуто 200 из 200
- `be.algo.graph-traversal`: sorted-neighbours — отвергнуто 739 из 739; queue-as-stack — отвергнуто 382 из 382; post-is-reversed-pre — отвергнуто 200 из 200; dfs-depth — отвергнуто 200 из 200; kahn-fifo — отвергнуто 400 из 400; cycle-only — отвергнуто 200 из 200; stack-as-recursion — отвергнуто 200 из 200; one-way-edges — отвергнуто 200 из 200; last-parent — отвергнуто 200 из 200
- `be.algo.heap-dijkstra`: fifo-ties — отвергнуто 406 из 406; no-stale — отвергнуто 370 из 370; first-discovery — отвергнуто 570 из 570; relax-on-equal — отвергнуто 289 из 289; stop-at-discovery — отвергнуто 200 из 200
- `be.algo.sorting-stability`: ties-alpha — отвергнуто 1122 из 1122; sort-returns-list — отвергнуто 200 из 200; reverse-flips-ties — отвергнуто 800 из 800; slice-reverse-stable — отвергнуто 200 из 200; first-field-only — отвергнуто 200 из 200; last-pass-only — отвергнуто 400 из 400; first-pass-primary — отвергнуто 396 из 396; max-last — отвергнуто 200 из 200; numeric-strings — отвергнуто 200 из 200; case-insensitive-default — отвергнуто 200 из 200; sort-copies — отвергнуто 200 из 200
- `be.algo.two-pointers`: last-max — отвергнуто 200 из 200; start-off-by-one — отвергнуто 200 из 200; ties-from-b — отвергнуто 200 из 200; tail-dropped — отвергнуто 200 из 200; all-pairs — отвергнуто 200 из 200; array-truncated — отвергнуто 200 из 200; left-moves-back — отвергнуто 200 из 200; shrink-once — отвергнуто 200 из 200; exactly-k — отвергнуто 200 из 200; window-never-empty — отвергнуто 200 из 200; one-per-step — отвергнуто 200 из 200
- `be.api.cors-preflight`: json-is-simple — отвергнуто 783 из 783; blocked-not-sent — отвергнуто 647 из 647; star-with-credentials — отвергнуто 474 из 474; safelisted-method-listed — отвергнуто 849 из 849; host-same-origin — отвергнуто 200 из 200; no-preflight-cache — отвергнуто 498 из 498; cache-any — отвергнуто 313 из 313; uncapped-max-age — отвергнуто 200 из 200; vary-harmless — отвергнуто 200 из 200
- `be.api.http-caching`: stale-full-fetch — отвергнуто 1246 из 1246; no-refresh-304 — отвергнуто 918 из 918; revalidate-without-etag — отвергнуто 200 из 200; no-cache-not-stored — отвергнуто 200 из 200; no-cache-as-fresh — отвергнуто 200 из 200; ignore-vary — отвергнуто 200 из 200; ignore-s-maxage — отвергнуто 200 из 200; private-cached — отвергнуто 200 из 200; swr-blocking — отвергнуто 200 из 200; swr-no-background — отвергнуто 200 из 200; expires-wins — отвергнуто 200 из 200; error-passthrough — отвергнуто 200 из 200; stale-forever — отвергнуто 200 из 200
- `be.api.idempotency-keys`: no-dedup — отвергнуто 1600 из 1600; body-ignored — отвергнуто 705 из 705; inflight-duplicate — отвергнуто 400 из 400; no-expiry — отвергнуто 600 из 600; store-5xx — отвергнуто 200 из 200; forget-4xx — отвергнуто 200 из 200; conflict-before-body — отвергнуто 200 из 200; dedup-by-body — отвергнуто 937 из 937; ttl-from-start — отвергнуто 200 из 200
- `be.api.optimistic-locking`: if-match-ignored — отвергнуто 800 из 800; put-as-patch — отвергнуто 205 из 205; patch-as-put — отвергнуто 218 из 218; version-on-412 — отвергнуто 800 из 800; own-write-keeps-etag — отвергнуто 200 из 200
- `be.api.pagination-consistency`: page-from-zero — отвергнуто 800 из 800; pages-floor — отвергнуто 800 из 800; ignore-tiebreak — отвергнуто 607 из 607; tiebreak-reversed — отвергнуто 729 из 729; filter-after-page — отвергнуто 200 из 200; frozen-snapshot — отвергнуто 600 из 600; offset-as-keyset — отвергнуто 200 из 200; keyset-as-offset — отвергнуто 600 из 600; cursor-created-only — отвергнуто 353 из 353; direction-all-keys — отвергнуто 200 из 200
- `be.api.rest-semantics`: put-missing-404 — отвергнуто 200 из 200; put-merges — отвергнуто 200 из 200; delete-repeat-204 — отвергнуто 200 из 200; id-reuse — отвергнуто 397 из 397; conflict-first — отвергнуто 200 из 200; not-allowed-as-404 — отвергнуто 200 из 200
- `be.api.retry-backoff`: no-cap — отвергнуто 680 из 680; pause-from-start — отвергнуто 1577 из 1577; ignore-retry-after — отвергнуто 569 из 569; retry-everything — отвергнуто 200 из 200; deadline-at-start — отвергнуто 400 из 400; retry-4xx — отвергнуто 302 из 302; limit-as-retries — отвергнуто 200 из 200
- `be.api.webhook-delivery`: apply-in-arrival-order — отвергнуто 616 из 616; seq-global — отвергнуто 763 из 763; mark-on-failure — отвергнуто 200 из 200; no-dedup — отвергнуто 600 из 600; refund-seq-checked — отвергнуто 500 из 500; reissue-detected — отвергнуто 200 из 200
- `be.api.webhook-signatures`: future-ok — отвергнуто 200 из 200; old-secret-forever — отвергнуто 200 из 200; all-signatures — отвергнуто 200 из 200; record-on-reject — отвергнуто 200 из 200; no-replay-check — отвергнуто 200 из 200; timestamp-not-signed — отвергнуто 200 из 200
- `be.code.order-summary`: no-tie-break — отвергнуто 1400 из 1400; ignores-status — отвергнуто 1600 из 1600; first-wins — отвергнуто 800 из 800; keeps-empty — отвергнуто 800 из 800; int32-sum — отвергнуто 800 из 800; streak-no-reset — отвергнуто 200 из 200
- `be.code.rate-limiter`: denied-counts — отвергнуто 1000 из 1000; window-edge — отвергнуто 1600 из 1600; shared-limit — отвергнуто 1600 из 1600
- `be.code.sessionize`: boundary — отвергнуто 1600 из 1600; global-gap — отвергнуто 1200 из 1200; sliding-window — отвергнуто 400 из 400; ignores-logout — отвергнуто 800 из 800; no-tie-break — отвергнуто 800 из 800; unclosed-last — отвергнуто 1600 из 1600; ignores-day — отвергнуто 400 из 400
- `be.code.stock-reservations`: stale-release — отвергнуто 1600 из 1600; exact-stock — отвергнуто 1200 из 1200; release-requested — отвергнуто 200 из 200; late-expiry — отвергнуто 400 из 400; single-warehouse — отвергнуто 800 из 800; confirm-returns — отвергнуто 1600 из 1600; queue-jump — отвергнуто 400 из 400; skip-ahead — отвергнуто 400 из 400
- `be.concurrency.asyncio-order`: eager-create — отвергнуто 1279 из 1279; lazy-tasks — отвергнуто 1461 из 1461; gather-completion-order — отвергнуто 200 из 200; get-always-yields — отвергнуто 200 из 200; set-switches — отвергнуто 200 из 200; unstarted-runs — отвергнуто 288 из 288; cancel-immediate — отвергнуто 600 из 600; lock-barging — отвергнуто 200 из 200; release-switches — отвергнуто 200 из 200; shield-cancels-inner — отвергнуто 200 из 200; no-propagation — отвергнуто 200 из 200; await-coro-as-task — отвергнуто 200 из 200; swallow-still-cancelled — отвергнуто 200 из 200
- `be.concurrency.deadlock-detect`: abort-oldest — отвергнуто 1000 из 1000; abort-requester — отвергнуто 610 из 610; abort-youngest-waiter — отвергнуто 251 из 251; shared-exclusive — отвергнуто 502 из 502; upgrade-free — отвергнуто 200 из 200; wait-aborts — отвергнуто 1468 из 1468; self-conflict — отвергнуто 400 из 400
- `be.concurrency.lost-update`: atomic — отвергнуто 1000 из 1000; ignore-lock — отвергнуто 200 из 200; lock-guards-data — отвергнуто 200 из 200; cas-as-write — отвергнуто 575 из 575; cas-no-retry — отвергнуто 584 из 584; aba-detected — отвергнуто 200 из 200; value-only-cas — отвергнуто 200 из 200; check-at-write — отвергнуто 200 из 200
- `be.concurrency.queue-redelivery`: ack-always-accepted — отвергнуто 482 из 482; no-visibility-expiry — отвергнуто 1282 из 1282; crash-immediate — отвергнуто 400 из 400; idempotent-ignored — отвергнуто 200 из 200; no-group-blocking — отвергнуто 400 из 400; global-blocking — отвергнуто 400 из 400; dlq-off-by-one — отвергнуто 600 из 600; dlq-never — отвергнуто 600 из 600; extend-adds — отвергнуто 200 из 200; release-not-counted — отвергнуто 200 из 200; release-to-end — отвергнуто 200 из 200
- `be.concurrency.sync-primitives`: sem-barging — отвергнуто 200 из 200; put-never-blocks — отвергнуто 600 из 600; wake-switches — отвергнуто 545 из 545; clear-cancels-wakeup — отвергнуто 200 из 200; set-switches — отвергнуто 200 из 200; notify-wakes-all — отвергнуто 200 из 200; putters-newest-first — отвергнуто 200 из 200; cancelled-put-enqueued — отвергнуто 200 из 200; wait-for-no-recheck — отвергнуто 200 из 200; join-on-empty — отвергнуто 200 из 200
- `be.db.case-coalesce`: case-last-match — отвергнуто 200 из 200; empty-is-null — отвергнуто 200 из 200; nullif-inverted — отвергнуто 200 из 200; text-as-number — отвергнуто 200 из 200; sort-by-label — отвергнуто 200 из 200
- `be.db.filter-order`: left-to-right — отвергнуто 200 из 200; between-exclusive — отвергнуто 200 из 200; underscore-any — отвергнуто 200 из 200; desc-all-keys — отвергнуто 200 из 200; offset-one-based — отвергнуто 200 из 200; not-whole-condition — отвергнуто 200 из 200
- `be.db.group-having`: having-before-where — отвергнуто 400 из 400; having-filters-rows — отвергнуто 600 из 600; count-else-zero — отвергнуто 200 из 200; empty-sum-zero — отвергнуто 400 из 400; filter-as-where — отвергнуто 200 из 200; case-last-match — отвергнуто 200 из 200; count-distinct-ignored — отвергнуто 200 из 200; real-division — отвергнуто 200 из 200
- `be.db.isolation-anomalies`: rc-snapshot-reads — отвергнуто 200 из 200; increment-lost — отвергнуто 200 из 200; rr-overwrites — отвергнуто 200 из 200; statement-rollback — отвергнуто 200 из 200; skew-undetected — отвергнуто 170 из 170; any-dependency-aborts — отвергнуто 30 из 30; rr-detects-skew — отвергнуто 217 из 217
- `be.db.join-multiplicity`: left-as-inner — отвергнуто 1000 из 1000; one-row-per-left — отвергнуто 400 из 400; wrong-side — отвергнуто 200 из 200; no-fanout — отвергнуто 200 из 200; rows-add — отвергнуто 200 из 200; distinct-by-row — отвергнуто 200 из 200; distinct-ignored — отвергнуто 200 из 200; implicit-key-join — отвергнуто 200 из 200; anti-as-not-equal — отвергнуто 200 из 200
- `be.db.null-aggregates`: count-star — отвергнуто 600 из 600; null-matches — отвергнуто 200 из 200; null-as-zero — отвергнуто 800 из 800; null-group-dropped — отвергнуто 200 из 200; on-as-where — отвергнуто 200 из 200; null-equals-null — отвергнуто 200 из 200
- `be.db.recursive-cte`: one-level — отвергнуто 1000 из 1000; anchor-excluded — отвергнуто 200 из 200; path-reversed — отвергнуто 200 из 200; self-excluded — отвергнуто 400 из 400; stops-early — отвергнуто 200 из 200; left-as-inner — отвергнуто 200 из 200; edges-undirected — отвергнуто 400 из 400; union-dedups-all — отвергнуто 200 из 200; limit-off-by-one — отвергнуто 200 из 200; shortest-only — отвергнуто 200 из 200
- `be.db.subquery-exists`: in-duplicates — отвергнуто 400 из 400; not-in-skips-null — отвергнуто 200 из 200; exists-checks-value — отвергнуто 200 из 200; exists-uncorrelated — отвергнуто 200 из 200; scalar-as-join — отвергнуто 200 из 200; empty-max-zero — отвергнуто 200 из 200; uncorrelated-avg — отвергнуто 200 из 200; one-per-group — отвергнуто 200 из 200
- `be.db.transactions-savepoint`: rollback-to-closes — отвергнуто 400 из 400; release-commits — отвергнуто 998 из 998; rollback-to-whole — отвергнуто 1200 из 1200; trigger-survives — отвергнуто 200 из 200; ids-not-reused — отвергнуто 594 из 594; name-finds-outer — отвергнуто 200 из 200; savepoint-no-transaction — отвергнуто 600 из 600
- `be.db.upsert-conflict`: replace-as-update — отвергнуто 600 из 600; ignore-overwrites — отвергнуто 600 из 600; excluded-is-old — отвергнуто 1000 из 1000; upsert-overwrites — отвергнуто 400 из 400; null-conflicts — отвергнуто 200 из 200; where-ignored — отвергнуто 200 из 200
- `be.db.window-functions`: rank-no-gaps — отвергнуто 200 из 200; dense-gaps — отвергнуто 200 из 200; no-order-running — отвергнуто 200 из 200; ignores-partition — отвергнуто 600 из 600; lag-lead-swapped — отвергнуто 200 из 200; frame-is-rows — отвергнуто 400 из 400; frame-whole-partition — отвергнуто 400 из 400; range-as-rows — отвергнуто 200 из 200; window-before-where — отвергнуто 200 из 200; window-before-having — отвергнуто 200 из 200
- `be.debug.api-handlers`: neighbour-line — отвергнуто 1600 из 1600; other-handler — отвергнуто 1600 из 1600
- `be.debug.async-races`: neighbour-line — отвергнуто 1600 из 1600; other-class — отвергнуто 1600 из 1600
- `be.debug.cache-invalidation`: neighbour-line — отвергнуто 800 из 800; other-unit — отвергнуто 800 из 800
- `be.debug.data-pipeline`: neighbour-line — отвергнуто 1600 из 1600; other-function — отвергнуто 1600 из 1600
- `be.debug.input-validation`: neighbour-line — отвергнуто 1600 из 1600; other-function — отвергнуто 1600 из 1600
- `be.debug.money-dates`: neighbour-line — отвергнуто 800 из 800; other-function — отвергнуто 800 из 800
- `be.debug.resource-timeouts`: neighbour-line — отвергнуто 1600 из 1600; other-function — отвергнуто 1600 из 1600
- `be.debug.spec-violation`: neighbour-line — отвергнуто 1600 из 1600; other-function — отвергнуто 1600 из 1600
- `be.design.cache-hit-ratio`: ttl-sliding — отвергнуто 274 из 274; ttl-inclusive — отвергнуто 237 из 237; fifo — отвергнуто 438 из 438; write-ignored — отвергнуто 724 из 724; around-as-through — отвергнуто 200 из 200; expired-first — отвергнуто 200 из 200
- `be.design.capacity-estimate`: average-load — отвергнуто 800 из 800; no-zone-loss — отвергнуто 800 из 800; full-utilization — отвергнуто 800 из 800; cpu-only — отвергнуто 400 из 400; simple-mean-cost — отвергнуто 200 из 200; ignore-fanout — отвергнуто 200 из 200; hits-as-load — отвергнуто 200 из 200
- `be.design.circuit-breaker`: timer-exclusive — отвергнуто 726 из 726; no-reset — отвергнуто 363 из 363; timer-not-restarted — отвергнуто 681 из 681; window-kept — отвергнуто 200 из 200; single-probe — отвергнуто 200 из 200; slow-ignored — отвергнуто 200 из 200
- `be.design.queue-backlog`: late-arrivals — отвергнуто 800 из 800; no-start-delay — отвергнуто 200 из 200; ignore-ordered — отвергнуто 200 из 200; ignore-partitions — отвергнуто 200 из 200; no-retries — отвергнуто 200 из 200; retry-next-interval — отвергнуто 200 из 200; pooled-partitions — отвергнуто 200 из 200
- `be.design.quorum-consistency`: write-to-down — отвергнуто 600 из 600; read-all-up — отвергнуто 561 из 561; strict-in-sloppy — отвергнуто 200 из 200; no-handoff — отвергнуто 200 из 200; no-repair — отвергнуто 200 из 200; issue-order-wins — отвергнуто 200 из 200
- `be.lang.classes-mro`: class-attr-per-instance — отвергнуто 400 из 400; iadd-updates-class — отвергнуто 200 из 200; dfs-mro — отвергнуто 200 из 200; super-is-parent — отвергнуто 200 из 200; identity-only — отвергнуто 200 из 200; key-replaced — отвергнуто 200 из 200; eq-only-hashable — отвергнуто 200 из 200; setter-bypassed — отвергнуто 200 из 200; getattr-always — отвергнуто 200 из 200
- `be.lang.closure-capture`: capture-by-value — отвергнуто 1200 из 1200; scope-leak — отвергнуто 200 из 200; default-at-call — отвергнуто 400 из 400; shared-factory-state — отвергнуто 400 из 400; frozen-at-loop-end — отвергнуто 200 из 200; assign-reads-outer — отвергнуто 200 из 200
- `be.lang.collections-trace`: ties-alpha — отвергнуто 200 из 200; dict-sorted — отвергнуто 400 из 400; stop-inclusive — отвергнуто 200 из 200; negative-off-by-one — отвергнуто 200 из 200; zip-longest — отвергнуто 200 из 200; enumerate-from-zero — отвергнуто 200 из 200; dict-first-wins — отвергнуто 200 из 200; get-stores-default — отвергнуто 200 из 200
- `be.lang.exceptions-flow`: most-specific — отвергнуто 200 из 200; else-after-except — отвергнуто 200 из 200; else-after-return — отвергнуто 200 из 200; finally-after-caller — отвергнуто 400 из 400; reraise-handled — отвергнуто 200 из 200; finally-before-except — отвергнуто 200 из 200; try-return-wins — отвергнуто 200 из 200; finally-keeps-exception — отвергнуто 200 из 200; return-reads-late — отвергнуто 200 из 200; sibling-handler — отвергнуто 200 из 200; cause-implicit — отвергнуто 200 из 200; from-clears-context — отвергнуто 200 из 200; finally-skipped-on-jump — отвергнуто 200 из 200; loop-else-always — отвергнуто 200 из 200; first-exception-wins — отвергнуто 200 из 200; context-lost — отвергнуто 200 из 200
- `be.lang.generators-iterators`: iter-restarts — отвергнуто 200 из 200; in-no-consume — отвергнуто 200 из 200; eager-genexp — отвергнуто 200 из 200; all-late — отвергнуто 200 из 200; runs-on-call — отвергнуто 200 из 200; eager-body — отвергнуто 200 из 200; send-returns-previous — отвергнуто 200 из 200; yield-from-none — отвергнуто 200 из 200; stop-value-lost — отвергнуто 200 из 200; zip-no-overconsume — отвергнуто 200 из 200; groupby-global — отвергнуто 200 из 200; groups-persist — отвергнуто 200 из 200; any-consumes-all — отвергнуто 200 из 200; all-empty-false — отвергнуто 200 из 200; zip-same-duplicates — отвергнуто 200 из 200; zip-pads-tail — отвергнуто 200 из 200
- `be.lang.mutable-aliasing`: assign-copies — отвергнуто 400 из 400; copy-aliases — отвергнуто 200 из 200; iadd-rebinds — отвергнуто 270 из 270; plus-mutates — отвергнуто 462 из 462; rows-independent — отвергнуто 200 из 200; shallow-is-deep — отвергнуто 200 из 200; shallow-is-alias — отвергнуто 200 из 200; default-fresh — отвергнуто 200 из 200; snapshot-at-return — отвергнуто 200 из 200; pass-by-value — отвергнуто 200 из 200; rebind-visible — отвергнуто 200 из 200; loop-var-writes-back — отвергнуто 200 из 200; fromkeys-copies — отвергнуто 200 из 200
- `be.lang.numbers-strings`: truncating-division — отвергнуто 200 из 200; half-up — отвергнуто 200 из 200; int-floors — отвергнуто 200 из 200; split-collapses — отвергнуто 200 из 200; stop-inclusive — отвергнуто 200 из 200; strip-substring — отвергнуто 200 из 200; count-overlapping — отвергнуто 200 из 200
- `qa.api.breaking-changes`: required-add-safe — отвергнуто 634 из 634; narrow-safe — отвергнуто 553 из 553; usage-ignored — отвергнуто 1155 из 1155; nullable-safe — отвергнуто 578 из 578; widen-safe — отвергнуто 542 из 542; tolerant-assumed — отвергнуто 848 из 848; default-safe — отвергнуто 485 из 485; removed-request-rejected — отвергнуто 267 из 267; enum-direction — отвергнуто 740 из 740
- `qa.api.conditional-requests`: last-write-wins — отвергнуто 625 из 625; put-keeps-etag — отвергнуто 702 из 702; missing-as-412 — отвергнуто 200 из 200; no-precondition-ok — отвергнуто 200 из 200; ims-strict — отвергнуто 460 из 460; weak-matches — отвергнуто 200 из 200; both-conditions — отвергнуто 200 из 200; ms-precision — отвергнуто 200 из 200; star-always-matches — отвергнуто 200 из 200
- `qa.api.idempotent-create`: replay-creates — отвергнуто 1373 из 1373; count-attempts — отвергнуто 1114 из 1114; no-key-deduped — отвергнуто 233 из 233; key-global — отвергнуто 291 из 291; replay-500 — отвергнуто 271 из 271; mismatch-replays — отвергнуто 475 из 475; no-expiry — отвергнуто 400 из 400; expiry-inclusive — отвергнуто 334 из 334; inflight-waits — отвергнуто 459 из 459
- `qa.api.pagination-drift`: offset-stable — отвергнуто 800 из 800; sides-swapped — отвергнуто 1600 из 1600; deleted-missed — отвергнуто 490 из 490; cursor-as-offset — отвергнуто 795 из 795; update-ignored — отвергнуто 600 из 600; tuple-assumed — отвергнуто 400 из 400
- `qa.api.rate-limit`: rejected-counted — отвергнуто 596 из 596; fixed-as-sliding — отвергнуто 706 из 706; sliding-as-fixed — отвергнуто 572 из 572; inclusive-boundary — отвергнуто 240 из 240; retry-full-period — отвергнуто 1587 из 1587; remaining-before — отвергнуто 1600 из 1600; bucket-no-cap — отвергнуто 600 из 600; bucket-discrete — отвергнуто 480 из 480; retry-min — отвергнуто 400 из 400
- `qa.api.response-body`: page-from-zero — отвергнуто 800 из 800; total-page-size — отвергнуто 1506 из 1506; total-unfiltered — отвергнуто 942 из 942; ties-table-order — отвергнуто 357 из 357; next-always — отвергнуто 851 из 851; next-if-full — отвергнуто 417 из 417; exclusive-range — отвергнуто 277 из 277; first-key-only — отвергнуто 200 из 200; offset-as-page — отвергнуто 735 из 735
- `qa.api.schema-violations`: null-nullable-violation — отвергнуто 852 из 852; null-required-ok — отвергнуто 641 из 641; missing-optional-violation — отвергнуто 1525 из 1525; string-scalar-ok — отвергнуто 568 из 568; enum-case-ok — отвергнуто 314 из 314; extra-allowed-violation — отвергнуто 475 из 475; extra-forbidden-ok — отвергнуто 247 из 247; empty-array-ok — отвергнуто 305 из 305; array-items-unchecked — отвергнуто 200 из 200; date-format-ok — отвергнуто 267 из 267
- `qa.api.status-codes`: anon-403 — отвергнуто 706 из 706; validation-400 — отвергнуто 531 из 531; success-200 — отвергнуто 1021 из 1021; auth-before-method — отвергнуто 207 из 207; existence-before-rights — отвергнуто 381 из 381; body-before-existence — отвергнуто 420 из 420; conflict-before-validation — отвергнуто 228 из 228; repeat-delete-204 — отвергнуто 213 из 213; deleted-title-taken — отвергнуто 202 из 202
- `qa.auto.cleanup-order`: teardownclass-after-error — отвергнуто 200 из 200; tests-run-after-class-error — отвергнуто 200 из 200; class-cleanup-skipped — отвергнуто 400 из 400; cleanup-fifo — отвергнуто 1172 из 1172; cleanup-chain-stops — отвергнуто 200 из 200; cleanup-error-ignored — отвергнуто 200 из 200; exitstack-fifo — отвергнуто 200 из 200; exit-after-teardown — отвергнуто 200 из 200; code-after-with-runs — отвергнуто 200 из 200; implicit-super — отвергнуто 200 из 200; class-cleanup-before-teardownclass — отвергнуто 200 из 200; teardownclass-error-skips-cleanup — отвергнуто 200 из 200; context-exits-after-setup — отвергнуто 200 из 200; cleanup-skipped-on-setup-error — отвергнуто 200 из 200; suppress-ignored — отвергнуто 200 из 200; suppress-resumes-inside — отвергнуто 200 из 200; suppress-any-type — отвергнуто 200 из 200; super-skips-to-testcase — отвергнуто 200 из 200; super-runs-first — отвергнуто 200 из 200
- `qa.auto.flaky-locate`: test-other-line — отвергнуто 1600 из 1600; product-line — отвергнуто 1600 из 1600
- `qa.auto.mock-behaviour`: return-value-wins — отвергнуто 400 из 400; return-value-after-exhaust — отвергнуто 200 из 200; side-effect-cycles — отвергнуто 200 из 200; exception-returned — отвергнуто 200 из 200; raising-call-not-counted — отвергнуто 400 из 400; default-as-is — отвергнуто 200 из 200; child-counted — отвергнуто 200 из 200; call-args-first — отвергнуто 200 из 200; reset-clears-config — отвергнуто 200 из 200; fresh-return-each-call — отвергнуто 200 из 200; mock-has-magic — отвергнуто 200 из 200; magic-falsy — отвергнуто 200 из 200
- `qa.auto.patch-target`: patch-source-everywhere — отвергнуто 400 из 400; patch-importer-only — отвергнуто 200 из 200; missing-attribute-created — отвергнуто 200 из 200; patch-persists — отвергнуто 1000 из 1000; top-down-args — отвергнуто 200 из 200; existing-instances-unaffected — отвергнуто 200 из 200; instance-patch-affects-class — отвергнуто 200 из 200; plain-mock-checks-signature — отвергнуто 200 из 200; autospec-ignores-signature — отвергнуто 200 из 200; rejected-call-counted — отвергнуто 200 из 200; patch-reaches-captured — отвергнуто 200 из 200; dict-replaced — отвергнуто 200 из 200; dict-keeps-added — отвергнуто 200 из 200; clear-ignored — отвергнуто 200 из 200; captured-constant-follows — отвергнуто 200 из 200; class-patch-covers-setup — отвергнуто 200 из 200; class-patch-shared-mock — отвергнуто 200 из 200
- `qa.auto.polling-wait`: sleep-before-check — отвергнуто 1200 из 1200; returns-at-event — отвергнуто 946 из 946; stops-at-deadline — отвергнуто 800 из 800; no-final-check — отвергнуто 600 из 600; sleep-after-last — отвергнуто 200 из 200; no-cap — отвергнуто 600 из 600; growth-first — отвергнуто 200 из 200; timeout-per-step — отвергнуто 200 из 200; deadline-after-sleep — отвергнуто 200 из 200; eventually-swallows — отвергнуто 200 из 200
- `qa.auto.result-summary`: subtest-as-tests — отвергнуто 200 из 200; subtest-stops — отвергнуто 200 из 200; error-as-failure — отвергнуто 702 из 702; unexpected-success-is-pass — отвергнуто 200 из 200; expected-failure-ignored — отвергнуто 200 из 200; xfail-error-is-error — отвергнуто 200 из 200; skipped-not-run — отвергнуто 501 из 501; skip-unless-inverted — отвергнуто 200 из 200; setup-error-as-failure — отвергнуто 200 из 200; one-outcome-per-test — отвергнуто 200 из 200
- `qa.auto.shared-state-order`: fresh-per-test — отвергнуто 600 из 600; declaration-order — отвергнуто 1528 из 1528; rebind-shares — отвергнуто 200 из 200; default-fresh — отвергнуто 200 из 200; setupclass-per-test — отвергнуто 200 из 200; shared-across-classes — отвергнуто 200 из 200; cache-per-test — отвергнуто 200 из 200; global-restored — отвергнуто 400 из 400; inherited-not-rerun — отвергнуто 200 из 200; subclass-own-copy — отвергнуто 200 из 200; restore-after-failure — отвергнуто 200 из 200; shallow-is-deep — отвергнуто 200 из 200; copy-is-alias — отвергнуто 200 из 200; iadd-rebinds — отвергнуто 200 из 200; int-iadd-shared — отвергнуто 200 из 200
- `qa.auto.unittest-lifecycle`: declaration-order — отвергнуто 800 из 800; teardown-skipped-on-failure — отвергнуто 294 из 294; rest-of-test-runs — отвергнуто 294 из 294; failure-stops-class — отвергнуто 401 из 401; teardown-after-setup-error — отвергнуто 200 из 200; cleanup-skipped-on-setup-error — отвергнуто 200 из 200; cleanup-fifo — отвергнуто 200 из 200; cleanup-before-teardown — отвергнуто 400 из 400; natural-order — отвергнуто 200 из 200; test-prefix-only — отвергнуто 200 из 200
- `qa.auto.vacuous-assertion`: distractor-assertion — отвергнуто 800 из 800; act-line — отвергнуто 800 из 800
- `qa.defects.bisect-first-bad`: first-red — отвергнуто 297 из 297; any-fail — отвергнуто 200 из 200; earliest-fail — отвергнуто 200 из 200; from-the-end — отвергнуто 200 из 200; other-rounding — отвергнуто 400 из 400; counts-ends — отвергнуто 800 из 800; skip-not-counted — отвергнуто 200 из 200; skip-older — отвергнуто 200 из 200; no-rerun — отвергнуто 200 из 200; counts-commits — отвергнуто 200 из 200
- `qa.defects.distributed-trace`: root-span — отвергнуто 1200 из 1200; shallow — отвергнуто 1200 из 1200; first-attempt — отвергнуто 400 из 400; reported-timeout — отвергнуто 400 из 400; deepest-error — отвергнуто 200 из 200; first-cancelled — отвергнуто 200 из 200; longest-child — отвергнуто 266 из 266; all-spans — отвергнуто 200 из 200
- `qa.defects.failing-cases`: boundary-miss — отвергнуто 762 из 762; not-manifest — отвергнуто 1600 из 1600; judges-by-actual — отвергнуто 800 из 800
- `qa.defects.flaky-order`: victim — отвергнуто 1600 из 1600; neighbour — отвергнуто 1400 из 1400; one-of-two — отвергнуто 600 из 600
- `qa.defects.log-deviation`: first-error — отвергнуто 1545 из 1545; arithmetic-only — отвергнуто 200 из 200; consequence — отвергнуто 200 из 200; global-state — отвергнуто 200 из 200; ignores-ttl — отвергнуто 200 из 200; shared-counter — отвергнуто 400 из 400; sliding-window — отвергнуто 200 из 200; utc-day — отвергнуто 200 из 200
- `qa.defects.race-log`: sequential — отвергнуто 1600 из 1600; counts-overwrites — отвергнуто 800 из 800; negative-stock — отвергнуто 400 из 400
- `qa.defects.spec-mismatch`: neighbour-line — отвергнуто 1600 из 1600; other-function — отвергнуто 1600 из 1600
- `qa.defects.stateful-bug`: neighbour-line — отвергнуто 1600 из 1600; symptom-line — отвергнуто 897 из 897
- `qa.defects.trace-localize`: last-step — отвергнуто 1600 из 1600; visible-step — отвергнуто 231 из 231; consumer-step — отвергнуто 1600 из 1600
- `qa.design.boundary-values`: inclusive-flip — отвергнуто 867 из 867; inside-only — отвергнуто 1600 из 1600; outer-only — отвергнуто 888 из 888; three-point — отвергнуто 1200 из 1200; two-point — отвергнуто 400 из 400; excluded-ignored — отвергнуто 200 из 200; loosest-limit — отвергнуто 200 из 200
- `qa.design.coverage-criteria`: no-base-subtract — отвергнуто 800 из 800; ignore-constraints — отвергнуто 1400 из 1400; greedy-cover — отвергнуто 200 из 200; each-sum — отвергнуто 400 из 400; keep-duplicates — отвергнуто 200 из 200; count-forbidden — отвергнуто 200 из 200; e-as-o — отвергнуто 200 из 200; o-as-e — отвергнуто 200 из 200; r-symmetric — отвергнуто 323 из 323
- `qa.design.date-boundaries`: end-exclusive — отвергнуто 200 из 200; inside-only — отвергнуто 200 из 200; count-from-event — отвергнуто 400 из 400; age-day-after — отвергнуто 400 из 400; age-year-only — отвергнуто 400 из 400; month-30-days — отвергнуто 400 из 400; month-overflow — отвергнуто 200 из 200; leap-other-day — отвергнуто 200 из 200; hours-as-days — отвергнуто 200 из 200; end-inclusive — отвергнуто 200 из 200; calendar-days — отвергнуто 200 из 200; holidays-ignored — отвергнуто 200 из 200
- `qa.design.decision-table`: boundary-strict — отвергнуто 719 из 719; dash-as-no — отвергнуто 1400 из 1400; last-match — отвергнуто 1131 из 1131; no-priority — отвергнуто 790 из 790; count-impossible — отвергнуто 600 из 600
- `qa.design.dependent-boundaries`: boundary-on-sum — отвергнуто 400 из 400; round-wrong — отвергнуто 600 из 600; inclusive-count — отвергнуто 400 из 400; month-30 — отвергнуто 303 из 303; ignore-fee — отвергнуто 400 из 400; round-down — отвергнуто 394 из 394; monotonic-assumption — отвергнуто 400 из 400; all-constraints — отвергнуто 400 из 400; off-point — отвергнуто 200 из 200
- `qa.design.equivalence-partitions`: merge-disjoint — отвергнуто 412 из 412; edge-flip — отвергнуто 1271 из 1271; boundary-class — отвергнуто 1446 из 1446; merge-format — отвергнуто 400 из 400; multi-invalid-counts — отвергнуто 569 из 569; invalid-covers-valid — отвергнуто 374 из 374; combination-counts — отвергнуто 220 из 220
- `qa.design.mcdc`: decision-ignored — отвергнуто 1515 из 1515; others-may-change — отвергнуто 1587 из 1587; greedy-pairs — отвергнуто 253 из 253; ignore-constraints — отвергнуто 800 из 800; n-plus-one — отвергнуто 200 из 200
- `qa.design.pairwise-constraints`: count-forbidden — отвергнуто 1400 из 1400; implication-symmetric — отвергнуто 1297 из 1297; keep-invalid — отвергнуто 600 из 600; direct-only — отвергнуто 800 из 800
- `qa.design.pairwise-count`: adjacent-only — отвергнуто 1492 из 1492; within-param — отвергнуто 1200 из 1200; pairs-as-combos — отвергнуто 782 из 782; constraint-ignored — отвергнуто 400 из 400; constraint-one-combo — отвергнуто 200 из 200; min-as-max — отвергнуто 200 из 200; each-value — отвергнуто 200 из 200; count-total — отвергнуто 200 из 200
- `qa.design.state-transitions`: invalid-changes — отвергнуто 1232 из 1232; self-loop-rejected — отвергнуто 1172 из 1172; counter-total — отвергнуто 200 из 200; no-reset — отвергнуто 758 из 758; event-coverage — отвергнуто 664 из 664
- `qa.design.transition-coverage`: forget-loops — отвергнуто 816 из 816; include-start — отвергнуто 600 из 600; include-unreachable — отвергнуто 200 из 200; skip-dead-end — отвергнуто 200 из 200; continue-after-invalid — отвергнуто 400 из 400; failed-test-counts-nothing — отвергнуто 312 из 312; greedy — отвергнуто 600 из 600
- `qa.mutants.api-access`: typical-only — отвергнуто 1600 из 1600; single-fault — отвергнуто 1600 из 1600; wrong-expected — отвергнуто 1600 из 1600; exhaustive — отвергнуто 1600 из 1600
- `qa.mutants.field-validation`: typical-only — отвергнуто 1600 из 1600; valid-only — отвергнуто 1600 из 1600; wrong-expected — отвергнуто 1600 из 1600; exhaustive — отвергнуто 1600 из 1600
- `qa.mutants.order-lifecycle`: happy-path — отвергнуто 1600 из 1600; limit-untested — отвергнуто 1600 из 1600; wrong-expected — отвергнуто 1600 из 1600; exhaustive — отвергнуто 1600 из 1600
- `qa.mutants.pricing-rules`: typical-only — отвергнуто 1600 из 1600; wrong-expected — отвергнуто 1600 из 1600; exhaustive — отвергнуто 1600 из 1600
- `qa.sql.null-traps`: not-in-ignores-null — отвергнуто 200 из 200; count-star — отвергнуто 200 из 200; eq-null-matches — отвергнуто 200 из 200; null-ne-true — отвергнуто 200 из 200; null-as-zero — отвергнуто 400 из 400; coalesce-ignored — отвергнуто 200 из 200; case-null-matches — отвергнуто 200 из 200; concat-skips-null — отвергнуто 200 из 200; not-includes-null — отвергнуто 200 из 200
- `qa.sql.orphans-duplicates`: null-fk-not-orphan — отвергнуто 400 из 400; normalized-assumed — отвергнуто 200 из 200; only-extras — отвергнуто 200 из 200; soft-deleted-orphans — отвергнуто 200 из 200; case-only — отвергнуто 200 из 200; trim-only — отвергнуто 200 из 200; null-groups-separate — отвергнуто 200 из 200; raw-group — отвергнуто 200 из 200; count-star — отвергнуто 200 из 200
- `qa.sql.reconciliation`: except-null-distinct — отвергнуто 200 из 200; except-keeps-duplicates — отвергнуто 200 из 200; ne-catches-null — отвергнуто 200 из 200; union-all — отвергнуто 200 из 200; null-key-matches — отвергнуто 200 из 200; null-group-excluded — отвергнуто 200 из 200; distinct-counts-null — отвергнуто 200 из 200
- `qa.sql.window-invariants`: lag-no-partition — отвергнуто 200 из 200; first-row-included — отвергнуто 200 из 200; touching-overlap — отвергнуто 200 из 200; lag-sees-all — отвергнуто 200 из 200; rows-frame — отвергнуто 200 из 200; filter-before-rank — отвергнуто 200 из 200; first-not-last — отвергнуто 200 из 200
- `qa.strategy.change-impact`: direct-only — отвергнуто 572 из 572; reverse-direction — отвергнуто 786 из 786; forget-always — отвергнуто 769 из 769; contract-transitive — отвергнуто 200 из 200; ignore-stable-api — отвергнуто 200 из 200; keep-quarantined — отвергнуто 200 из 200
- `qa.strategy.exit-criteria`: ge-vs-gt — отвергнуто 400 из 400; count-rejected — отвергнуто 589 из 589; percent-of-executed — отвергнуто 110 из 110; denominator-all-phases — отвергнуто 200 из 200; waivable-as-waived — отвергнуто 86 из 86; flaky-includes-broken — отвергнуто 200 из 200
- `qa.strategy.parallel-shards`: no-sort — отвергнуто 586 из 586; round-robin — отвергнуто 790 из 790; ignore-groups — отвергнуто 200 из 200; least-loaded — отвергнуто 200 из 200; sorted-queue — отвергнуто 200 из 200
- `qa.strategy.requirements-traceability`: any-pass-suffices — отвергнуто 600 из 600; tests-denominator — отвергнуто 400 из 400; blocked-as-run — отвергнуто 400 из 400; round-up — отвергнуто 356 из 356
- `qa.strategy.risk-based-selection`: stop-at-misfit — отвергнуто 758 из 758; sum-not-product — отвергнуто 1531 из 1531; ignore-tie-rule — отвергнуто 309 из 309; risk-not-density — отвергнуто 200 из 200; ignore-mandatory — отвергнуто 400 из 400; ignore-dependencies — отвергнуто 200 из 200; api-full — отвергнуто 200 из 200; greedy-not-optimal — отвергнуто 400 из 400

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

## Выпуск и вместимость

### backend

| Грейд  | be.lang | be.algo | be.db | be.api | be.concurrency | be.debug | be.design | be.code |
| ------ | ------- | ------- | ----- | ------ | -------------- | -------- | --------- | ------- |
| intern | 5 / 5   | 4 / 3   | 5 / 3 | 1 / 1  | —              | 4 / 3    | —         | 2 / 1   |
| junior | 4 / 4   | 4 / 3   | 5 / 4 | 5 / 3  | —              | 4 / 3    | —         | 2 / 1   |
| middle | 2 / 2   | 2 / 2   | 5 / 4 | 4 / 3  | 5 / 3          | 4 / 3    | —         | 2 / 1   |
| senior | —       | —       | 4 / 3 | 4 / 3  | 5 / 4          | 2 / 2    | 5 / 5     | 2 / 1   |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                     | Итог | Нехватка |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                           | ok   |          |
| intern | A11                                                                                                                          | ok   |          |
| intern | A16 → B16 → block:be.lang → block:be.algo → block:be.db → block:be.debug → recheck:be.lang → recheck:be.db                   | ok   |          |
| intern | B6                                                                                                                           | ok   |          |
| intern | B11                                                                                                                          | ok   |          |
| intern | B16 → A16 → block:be.lang → block:be.algo → block:be.db → block:be.debug → recheck:be.lang → recheck:be.db                   | ok   |          |
| junior | A6                                                                                                                           | ok   |          |
| junior | A11                                                                                                                          | ok   |          |
| junior | A18 → B18 → block:be.lang → block:be.algo → block:be.db → block:be.api → block:be.debug → recheck:be.db → recheck:be.api     | ok   |          |
| junior | B6                                                                                                                           | ok   |          |
| junior | B11                                                                                                                          | ok   |          |
| junior | B18 → A18 → block:be.lang → block:be.algo → block:be.db → block:be.api → block:be.debug → recheck:be.db → recheck:be.api     | ok   |          |
| middle | A6                                                                                                                           | ok   |          |
| middle | A11                                                                                                                          | ok   |          |
| middle | A18 → B18 → block:be.db → block:be.api → block:be.concurrency → block:be.debug → recheck:be.db → recheck:be.concurrency      | ok   |          |
| middle | B6                                                                                                                           | ok   |          |
| middle | B11                                                                                                                          | ok   |          |
| middle | B18 → A18 → block:be.db → block:be.api → block:be.concurrency → block:be.debug → recheck:be.db → recheck:be.concurrency      | ok   |          |
| senior | A6                                                                                                                           | ok   |          |
| senior | A11                                                                                                                          | ok   |          |
| senior | A18 → B18 → block:be.db → block:be.api → block:be.concurrency → block:be.design → recheck:be.concurrency → recheck:be.design | ok   |          |
| senior | B6                                                                                                                           | ok   |          |
| senior | B11                                                                                                                          | ok   |          |
| senior | B18 → A18 → block:be.db → block:be.api → block:be.concurrency → block:be.design → recheck:be.concurrency → recheck:be.design | ok   |          |

Проблем выпуска нет.

### qa

| Грейд  | qa.design | qa.defects | qa.api | qa.auto | qa.sql | qa.strategy | qa.mutants |
| ------ | --------- | ---------- | ------ | ------- | ------ | ----------- | ---------- |
| intern | 6 / 6     | 5 / 4      | 4 / 3  | —       | 2 / 2  | —           | 2 / 1      |
| junior | 6 / 5     | 5 / 4      | 4 / 3  | 4 / 3   | 2 / 2  | —           | 2 / 1      |
| middle | 5 / 4     | 4 / 3      | 4 / 3  | 5 / 4   | 2 / 2  | 1 / 1       | 2 / 1      |
| senior | 5 / 3     | 4 / 3      | 4 / 2  | 5 / 4   | —      | 5 / 5       | 2 / 1      |

Семейств-уровней в блоке / квота блока на самой длинной траектории.

| Грейд  | Сценарий                                                                                                                   | Итог | Нехватка |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| intern | A6                                                                                                                         | ok   |          |
| intern | A11                                                                                                                        | ok   |          |
| intern | A16 → B16 → block:qa.design → block:qa.defects → block:qa.api → recheck:qa.design → recheck:qa.defects                     | ok   |          |
| intern | B6                                                                                                                         | ok   |          |
| intern | B11                                                                                                                        | ok   |          |
| intern | B16 → A16 → block:qa.design → block:qa.defects → block:qa.api → recheck:qa.design → recheck:qa.defects                     | ok   |          |
| junior | A6                                                                                                                         | ok   |          |
| junior | A11                                                                                                                        | ok   |          |
| junior | A18 → B18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.design → recheck:qa.defects     | ok   |          |
| junior | B6                                                                                                                         | ok   |          |
| junior | B11                                                                                                                        | ok   |          |
| junior | B18 → A18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.design → recheck:qa.defects     | ok   |          |
| middle | A6                                                                                                                         | ok   |          |
| middle | A11                                                                                                                        | ok   |          |
| middle | A18 → B18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.auto → recheck:qa.design        | ok   |          |
| middle | B6                                                                                                                         | ok   |          |
| middle | B11                                                                                                                        | ok   |          |
| middle | B18 → A18 → block:qa.design → block:qa.defects → block:qa.api → block:qa.auto → recheck:qa.auto → recheck:qa.design        | ok   |          |
| senior | A6                                                                                                                         | ok   |          |
| senior | A11                                                                                                                        | ok   |          |
| senior | A18 → B18 → block:qa.design → block:qa.defects → block:qa.auto → block:qa.strategy → recheck:qa.strategy → recheck:qa.auto | ok   |          |
| senior | B6                                                                                                                         | ok   |          |
| senior | B11                                                                                                                        | ok   |          |
| senior | B18 → A18 → block:qa.design → block:qa.defects → block:qa.auto → block:qa.strategy → recheck:qa.strategy → recheck:qa.auto | ok   |          |

Проблем выпуска нет.

Выжившие мутанты `be.code.rate-limiter`:

- middle/sliding-counter#1: line 5: const -> 1
- middle/sliding-counter#1: line 9: const -> -1
- middle/sliding-counter#2: line 9: const -> -1
- senior/sliding-counter#0: line 5: const -> 1
- senior/sliding-counter#0: line 5: const -> -1
- senior/sliding-counter#0: line 9: const -> -1
- senior/sliding-counter#1: line 5: const -> -1
- senior/sliding-counter#1: line 9: const -> -1
- senior/sliding-counter#2: line 5: const -> -1
- senior/sliding-counter#2: line 9: const -> -1
