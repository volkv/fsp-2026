# Отчёт ворот банка

Среда исполнения: образ песочницы `fsp-sandbox:test` — Python 3.13.15, SQLite 3.46.1. Сидов на класс: 200. Проверено семейств: 4, время 610 с.

## Семейства

| Семейство                    | Формат        | Уровни         | Экз. | Эталон: отказов | Ошибочные: поймано | Коллизия | Пересечение классов | Мутанты (убито / всего − экв.) | Перенос | Проблем |
| ---------------------------- | ------------- | -------------- | ---- | --------------- | ------------------ | -------- | ------------------- | ------------------------------ | ------- | ------- |
| `be.code.order-summary`      | practice_code | intern, junior | 1600 | 0               | 7 / 7              | 0        | —                   | 609 / 654 − 45 = 1             | 0.0006  | 0       |
| `be.code.rate-limiter`       | practice_code | middle, senior | 1600 | 0               | 5 / 5              | 0        | —                   | 881 / 924 − 40 = 0.9966        | 0.0017  | 0       |
| `be.code.sessionize`         | practice_code | intern, junior | 1600 | 0               | 7 / 7              | 0        | —                   | 1408 / 1440 − 23 = 0.9936      | 0.0026  | 0       |
| `be.code.stock-reservations` | practice_code | middle, senior | 1600 | 0               | 9 / 9              | 0        | —                   | 2073 / 2088 − 12 = 0.9986      | 0.0059  | 0       |

## Ошибочные решения

- `be.code.order-summary`: no-tie-break — отвергнуто 1400 из 1400; ignores-status — отвергнуто 1600 из 1600; first-wins — отвергнуто 800 из 800; keeps-empty — отвергнуто 800 из 800; int32-sum — отвергнуто 800 из 800; streak-no-reset — отвергнуто 200 из 200; min-before-latest — отвергнуто 800 из 800
- `be.code.rate-limiter`: denied-counts — отвергнуто 1400 из 1400; window-edge — отвергнуто 1600 из 1600; shared-limit — отвергнуто 1600 из 1600; continuous-refill — отвергнуто 400 из 400; own-spent-on-global-deny — отвергнуто 1400 из 1400
- `be.code.sessionize`: boundary — отвергнуто 1600 из 1600; global-gap — отвергнуто 1200 из 1200; sliding-window — отвергнуто 400 из 400; ignores-logout — отвергнуто 800 из 800; no-tie-break — отвергнуто 800 из 800; unclosed-last — отвергнуто 1600 из 1600; ignores-day — отвергнуто 400 из 400
- `be.code.stock-reservations`: stale-release — отвергнуто 1600 из 1600; exact-stock — отвергнуто 1200 из 1200; release-requested — отвергнуто 200 из 200; late-expiry — отвергнуто 400 из 400; single-warehouse — отвергнуто 600 из 600; confirm-returns — отвергнуто 1600 из 1600; queue-jump — отвергнуто 400 из 400; skip-ahead — отвергнуто 400 из 400; release-waiting-no-serve — отвергнуто 400 из 400

## Проблемы ворот

Нет.

## Валидатор контракта

- (awaiting_raters) family be.code.order-summary@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.75)
- (awaiting_raters) family be.code.order-summary@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family be.code.order-summary: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.code.rate-limiter@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.85)
- (awaiting_raters) family be.code.rate-limiter@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.85)
- (awaiting_reviews) family be.code.rate-limiter: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.code.sessionize@intern: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family be.code.sessionize@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.75)
- (awaiting_reviews) family be.code.sessionize: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources
- (awaiting_raters) family be.code.stock-reservations@middle: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_raters) family be.code.stock-reservations@senior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.8)
- (awaiting_reviews) family be.code.stock-reservations: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources

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

Выжившие мутанты `be.code.rate-limiter`:

- senior/sliding-counter#0: line 5: const -> 1
- senior/sliding-counter#2: line 5: const -> 1
- senior/sliding-counter#2: line 9: const -> -1

Выжившие мутанты `be.code.sessionize`:

- intern/gap#0: line 9: const -> 1
- intern/gap#1: line 9: const -> 1
- intern/gap-capped#0: line 9: const -> 1
- intern/gap-capped#2: line 9: const -> 1
- intern/gap-capped#2: line 9: const -> -1
- intern/gap-daily#1: line 9: const -> -1
- intern/gap-daily#1: line 10: const -> 1
- intern/gap-daily#2: line 9: const -> 1
- junior/gap-daily#0: line 10: const -> 2

Выжившие мутанты `be.code.stock-reservations`:

- senior/expiring#0: line 12: const -> 2
- senior/expiring#1: line 12: const -> 2
- senior/expiring#2: line 12: const -> 2
