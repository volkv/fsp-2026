"""Methodology v3 of the shortlist evaluation (README «Методика v3», docs/contracts.md 10.2): three checks over the
same world, each with its own question, fixed before the runs that use it.

(a) Conformance to the requirements of the task (`shortlist.tz.*`): no position of a category shortlist held by a
    person without a category the world confirms; the product's categories of every person are the ones their decisions
    give; the positions of a shortlist are in the categories the need admits (the specialization of its role, the grades
    of its range, a lead being a senior of the catalog); what a test confirmed is held by the person.
(b) The shortlist as a whole (`shortlist.*`): the pool is every person of the split with an honest confirmation;
    the relevance of every person for every need is rubric v3 (matching.py) of the need as its employer states it,
    never what the product chose; the product's shortlist against named baselines under the same conditions. A need
    nobody in the pool is suitable for (relevance 2 or 3) is not rated: its share is reported apart, «честно пусто».
(c) Sorting (`shortlist.sorting.*`): the product's ranking and the keyword sorting of the same requirements over one set
    fixed before the run — the people of the pool holding a category the need admits.

The product shows after its shortlist the group «грейд не подтверждён» (domain 13.10): people without a category of the
need whose own declaration names one. They are not of the pool, and every measure of (a)–(c) reads the shortlist
without them; their share of the first ten the product shows is reported apart (`shortlist.unconfirmed_share_top10`),
next to what Precision@10 would read if the group counted (`shortlist.precision_at_10.with_unconfirmed_tail`), so
that a measure cannot rise on the group.

Baselines, each named by what it is given:
- `keywords_same_text` — automation from the same input: BM25 of the need's text over the resume texts of the pool;
- `keywords_same_requirements` — sorting under the same requirements: the names of the skills the product read from the
  need (its required worth two, its nice worth one) searched in the resume texts;
- `keywords_manual_query` — a recruiter's query written by hand from the need's own requirements (the names the need
  prints), searched the same way;
- `random` — the expected nDCG@10 of a random order of the pool.

Metrics, each at 10 positions: nDCG@10 (gain `2^rel − 1`), Precision@10 with the denominator 10 (relevance 2–3),
Recall@10 of the suitable people (relevance 2–3), MRR of the first suitable person in the whole order (0 when the order
has none). Paired bootstrap intervals over needs, 95 %.
"""

import hashlib
import math
import random
import re
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from fsp_eval.matching import (
    TEST_SPECIALIZATION,
    VOCABULARY,
    Truth,
    Vacancy,
    admissible_categories,
    need_text,
    relevance,
    vacancy_name,
)
from fsp_eval.metrics import MetricTable

K = 10
SUITABLE = 2
BOOTSTRAP_SAMPLES = 2000
GROUP = "shortlist"

# --- Measures of one order --------------------------------------------------------------------------------------------


def _gain(rel: int) -> float:
    return 2.0**rel - 1


def _discount(position: int) -> float:
    return 1 / math.log2(position + 2)


def _check(order: Sequence[str], rels: Mapping[str, int]) -> None:
    if len(set(order)) != len(order) or not set(order) <= set(rels):
        raise ValueError("the ranking holds people outside the pool or repeats one")


def ndcg(order: Sequence[str], rels: Mapping[str, int], k: int = K) -> float:
    """nDCG@k against the ideal order of everyone in `rels`; a shorter order gains nothing for the positions it lacks.
    The caller skips a need without a relevant person."""
    _check(order, rels)
    dcg = sum(_gain(rels[pid]) * _discount(i) for i, pid in enumerate(order[:k]))
    ideal = sum(_gain(rel) * _discount(i) for i, rel in enumerate(sorted(rels.values(), reverse=True)[:k]))
    return dcg / ideal


def precision_at(order: Sequence[str], rels: Mapping[str, int], k: int = K) -> float:
    """The share of suitable people among k positions, out of k: a short list does not count higher."""
    _check(order, rels)
    return sum(rels[pid] >= SUITABLE for pid in order[:k]) / k


def recall_at(order: Sequence[str], rels: Mapping[str, int], k: int = K) -> float:
    """The share of the suitable people of the pool among the first k."""
    _check(order, rels)
    suitable = sum(rel >= SUITABLE for rel in rels.values())
    return sum(rels[pid] >= SUITABLE for pid in order[:k]) / suitable


def reciprocal_rank(order: Sequence[str], rels: Mapping[str, int]) -> float:
    """1 / the position of the first suitable person in the whole order; 0 when the order has none."""
    _check(order, rels)
    return next((1 / (i + 1) for i, pid in enumerate(order) if rels[pid] >= SUITABLE), 0.0)


def random_ndcg(rels: Mapping[str, int], k: int = K) -> float:
    """Expected nDCG@k of a uniformly random order: every position holds the mean gain of the pool."""
    mean = sum(_gain(rel) for rel in rels.values()) / len(rels)
    ideal = sum(_gain(rel) * _discount(i) for i, rel in enumerate(sorted(rels.values(), reverse=True)[:k]))
    return mean * sum(_discount(i) for i in range(min(k, len(rels)))) / ideal


MEASURES: dict[str, Callable[[Sequence[str], Mapping[str, int]], float]] = {
    "ndcg_at_10": ndcg,
    "precision_at_10": precision_at,
    "recall_at_10": recall_at,
    "mrr": reciprocal_rank,
}

# --- Baselines --------------------------------------------------------------------------------------------------------


def tie_break(seed: int, need_id: str, profile_id: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}:tie:{need_id}:{profile_id}".encode()).digest()[:8], "big")


def name_order(
    required: Sequence[str], nice: Sequence[str], texts: Mapping[str, str | None], seed: int, need_id: str
) -> list[str]:
    """Names searched as whole words in the resume texts, a required name worth two and a nice one worth one; ties in
    a fixed pseudo-random order."""

    def pattern(name: str) -> re.Pattern[str]:
        return re.compile(rf"(?<![\w+#.]){re.escape(name)}(?![\w+#])", re.IGNORECASE)

    weights = [(pattern(name), 2) for name in required] + [(pattern(name), 1) for name in nice]

    def score(text: str | None) -> int:
        return 0 if text is None else sum(weight for p, weight in weights if p.search(text))

    return sorted(texts, key=lambda pid: (-score(texts[pid]), tie_break(seed, need_id, pid)))


TOKEN = re.compile(r"[\w+#]+")
BM25_K1 = 1.2
BM25_B = 0.75


def tokens(text: str) -> list[str]:
    return [token for token in TOKEN.findall(text.casefold().replace("ё", "е")) if len(token) > 1]


def bm25_order(query: str, texts: Mapping[str, str | None], seed: int, need_id: str) -> list[str]:
    """BM25 of the query's words over the texts (Robertson–Zaragoza, k1 1.2, b 0.75); an unread document scores 0."""
    docs = {pid: Counter(tokens(text)) if text is not None else Counter() for pid, text in texts.items()}
    lengths = {pid: sum(doc.values()) for pid, doc in docs.items()}
    average = sum(lengths.values()) / len(docs) if docs else 0.0
    terms = set(tokens(query))
    frequency = {term: sum(term in doc for doc in docs.values()) for term in terms}
    idf = {term: math.log((len(docs) - df + 0.5) / (df + 0.5) + 1) for term, df in frequency.items()}

    def score(pid: str) -> float:
        doc, length = docs[pid], lengths[pid]
        if length == 0:
            return 0.0
        norm = BM25_K1 * (1 - BM25_B + BM25_B * length / average)
        return sum(idf[t] * doc[t] * (BM25_K1 + 1) / (doc[t] + norm) for t in terms if doc[t])

    return sorted(texts, key=lambda pid: (-score(pid), tie_break(seed, need_id, pid)))


# --- Inputs of the evaluation -----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ProductNeed:
    """What the product read of a need and the categories of its shortlist (the bridge's `needs`)."""

    specialization: str | None
    skill_keys: tuple[str, ...]
    nice_skill_keys: tuple[str, ...]
    categories: frozenset[tuple[str, str]]


@dataclass(frozen=True)
class Inputs:
    seed: int
    needs: Sequence[Vacancy]
    texts: Mapping[str, str]
    truths: Mapping[str, Truth]
    # The category each person of the split holds by their honest decisions; absent — none.
    categories: Mapping[str, tuple[str, str]]
    # The same in the scenario of false confirmations: the people it confirms.
    false_categories: Mapping[str, tuple[str, str]]
    product_needs: Mapping[str, ProductNeed]
    # Person → the categories the product holds for them, with the skills each confirms (the bridge's `categories`).
    product_categories: Mapping[str, Sequence[tuple[str, str, frozenset[str]]]]
    # Variant → need → the product's order of people.
    rankings: Mapping[str, Mapping[str, Sequence[str]]]
    names: Mapping[str, str]
    semantic_used: bool
    with_fsp: frozenset[str] = frozenset()
    top: Mapping[str, Mapping[str, Sequence[Mapping[str, Any]]]] = field(default_factory=dict)
    # Need → the product's group «грейд не подтверждён» after the shortlist of the variant `full`, in its order.
    declared: Mapping[str, Sequence[str]] = field(default_factory=dict)

    @property
    def pool(self) -> list[str]:
        return sorted(self.categories)


# Product variants a run ranks: everything; without the FSP achievements; without the semantic similarity (only in a run
# with an embedder); the scenario of false confirmations; the sorting of the admissible set.
VARIANTS = ("full", "without_fsp", "without_semantic")


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _interval(seed: int, deltas: Sequence[float]) -> tuple[float, float]:
    """95 % percentile bootstrap interval of the mean of paired per-need differences."""
    rng = random.Random(f"{seed}:bootstrap")
    means = sorted(
        sum(deltas[rng.randrange(len(deltas))] for _ in deltas) / len(deltas) for _ in range(BOOTSTRAP_SAMPLES)
    )
    return means[int(0.025 * BOOTSTRAP_SAMPLES)], means[int(0.975 * BOOTSTRAP_SAMPLES) - 1]


def paired_delta(seed: int, product: Sequence[float], other: Sequence[float]) -> dict[str, Any]:
    paired = [a - b for a, b in zip(product, other, strict=True)]
    low, high = _interval(seed, paired)
    return {"mean": sum(paired) / len(paired), "ci95": [low, high], "n": len(paired)}


def _names(keys: Sequence[str], names: Mapping[str, str]) -> list[str]:
    missing = [key for key in keys if key not in names]
    if missing:
        raise ValueError(f"the taxonomy names no skill {', '.join(missing)}")
    return [names[key] for key in keys]


def baseline_orders(inputs: Inputs, need: Vacancy, people: Sequence[str]) -> dict[str, list[str]]:
    texts = {pid: inputs.texts.get(pid) for pid in people}
    read = inputs.product_needs[need.id]
    return {
        "keywords_same_text": bm25_order(need_text(need), texts, inputs.seed, need.id),
        "keywords_same_requirements": name_order(
            _names(read.skill_keys, inputs.names),
            _names(read.nice_skill_keys, inputs.names),
            texts,
            inputs.seed,
            need.id,
        ),
        "keywords_manual_query": name_order(
            [vacancy_name(key) for key in need.required],
            [vacancy_name(key) for key in need.nice],
            texts,
            inputs.seed,
            need.id,
        ),
    }


SYSTEMS = ("full", "keywords_same_text", "keywords_same_requirements", "keywords_manual_query")
BASELINES = ("keywords_same_text", "keywords_same_requirements", "keywords_manual_query")


def _slices(need: Vacancy) -> dict[str, str]:
    """The cuts of a need the report gives every measure by."""
    return {
        "role": need.role,
        "specialization": TEST_SPECIALIZATION.get(need.role, "none"),
        "grade_min": need.grade_min,
        "lead": "range_with_lead" if need.grade_max == "lead" else "no_lead",
        "format": need.work_format,
        "region": "region" if need.region is not None else "remote",
        "salary": "below_market" if need.below_market else "market",
        "fsp": "algorithmic" if need.algorithmic else "other",
    }


@dataclass
class _Judged:
    """(b), need by need: every measure of every order, the ceilings of the pool and of the product's categories, the
    needs without a suitable person, the exposure of the inflated and of the people without FSP."""

    per_need: dict[str, dict[str, Any]] = field(default_factory=dict)
    values: dict[str, dict[str, list[float]]] = field(default_factory=lambda: {m: {} for m in MEASURES})
    ceilings: dict[str, list[float]] = field(
        default_factory=lambda: {"precision": [], "recall": [], "ndcg_admitted": [], "recall_admitted": []}
    )
    random_values: list[float] = field(default_factory=list)
    without_suitable: list[str] = field(default_factory=list)
    exposure: dict[str, list[float]] = field(
        default_factory=lambda: {
            "inflated_full": [],
            "inflated_keywords": [],
            "fsp_top": [],
            "fsp_all": [],
            "unconfirmed_top": [],
            "unconfirmed_all": [],
        }
    )
    with_tail: list[float] = field(default_factory=list)

    def expose(self, inputs: Inputs, orders: Mapping[str, Sequence[str]]) -> None:
        for name, key in (("full", "inflated_full"), ("keywords_same_text", "inflated_keywords")):
            first = orders[name][:K]
            if first:
                self.exposure[key].append(sum(inputs.truths[pid].inflation != "honest" for pid in first) / len(first))
        shortlist = orders["full"]
        if shortlist:
            first = shortlist[:K]
            self.exposure["fsp_top"].append(sum(pid not in inputs.with_fsp for pid in first) / len(first))
            self.exposure["fsp_all"].append(sum(pid not in inputs.with_fsp for pid in shortlist) / len(shortlist))

    def expose_group(self, shown: Sequence[str], group: Sequence[str]) -> None:
        """The share of the group «грейд не подтверждён» in the first ten the product shows and in all it shows."""
        if shown:
            first = shown[:K]
            self.exposure["unconfirmed_top"].append(sum(pid in group for pid in first) / len(first))
            self.exposure["unconfirmed_all"].append(len(group) / len(shown))

    def rate(self, row: dict[str, Any], orders: Mapping[str, Sequence[str]], rels: Mapping[str, int]) -> None:
        suitable = row["suitable"]
        for measure, function in MEASURES.items():
            for name, order in orders.items():
                value = function(order, rels)
                self.values[measure].setdefault(name, []).append(value)
                row.setdefault(measure, {})[name] = value
        self.random_values.append(random_ndcg(rels))
        admitted = sorted(orders["full"], key=lambda pid: -rels[pid])
        self.ceilings["precision"].append(min(K, suitable) / K)
        self.ceilings["recall"].append(min(K, suitable) / suitable)
        self.ceilings["ndcg_admitted"].append(ndcg(admitted, rels) if admitted else 0.0)
        self.ceilings["recall_admitted"].append(sum(rels[pid] >= SUITABLE for pid in admitted) / suitable)
        row["top10"] = {
            name: [{"profile_id": pid, "relevance": rels[pid]} for pid in order[:K]] for name, order in orders.items()
        }


def _judge(inputs: Inputs, pool: Sequence[str], variants: Sequence[str]) -> _Judged:
    judged = _Judged()
    for need in inputs.needs:
        orders = {name: list(inputs.rankings[name][need.id]) for name in variants}
        orders |= baseline_orders(inputs, need, pool)
        # Everyone an order holds is judged: a person outside the pool in a shortlist breaks (a) and is counted there.
        people = set(pool).union(*orders.values())
        rels = {pid: relevance(need, inputs.truths[pid]) for pid in people}
        judged.expose(inputs, orders)
        group = list(inputs.declared.get(need.id, ()))
        if set(group) & set(orders["full"]):
            raise ValueError(f"need {need.id}: the group «грейд не подтверждён» repeats people of the shortlist")
        shown = [*orders["full"], *group]
        judged.expose_group(shown, group)
        row: dict[str, Any] = {
            "suitable": sum(rel >= SUITABLE for rel in rels.values()),
            "partial": sum(rel == 1 for rel in rels.values()),
            "shortlist": len(orders["full"]),
            "slices": _slices(need),
        }
        row["unconfirmed"] = len(group)
        if row["suitable"] == 0:
            judged.without_suitable.append(need.id)
        else:
            judged.rate(row, orders, rels)
            # What Precision@10 would read if the group counted: the measure of record never does.
            tail_rels = {**rels, **{pid: relevance(need, inputs.truths[pid]) for pid in group}}
            judged.with_tail.append(precision_at(shown, tail_rels))
        judged.per_need[need.id] = row
    return judged


def _put_whole(table: MetricTable, inputs: Inputs, judged: _Judged, variants: Sequence[str]) -> dict[str, Any]:
    """The rows of (b); the paired differences of the product and every other order returned."""
    rated = len(judged.random_values)
    values, ceilings, exposure = judged.values, judged.ceilings, judged.exposure
    deltas = {
        measure: {
            other: paired_delta(inputs.seed, values[measure]["full"], values[measure][other])
            for other in (*BASELINES, *(name for name in variants if name != "full"))
            if rated
        }
        for measure in MEASURES
    }
    mean = {measure: {name: _mean(series) for name, series in by.items()} for measure, by in values.items()}
    full = mean["ndcg_at_10"].get("full")

    def put(key: str, value: float | None, n: int, baseline: float | None = None, *, with_baseline: bool) -> None:
        table.put(f"{GROUP}.{key}", value, n, baseline, with_baseline=with_baseline)

    for measure in MEASURES:
        by = mean[measure]
        put(measure, by.get("full"), rated, by.get("keywords_same_text"), with_baseline=True)
        for name in BASELINES:
            put(f"{measure}.{name}", by.get(name), rated, with_baseline=False)
    lift = deltas["ndcg_at_10"].get("keywords_same_text")
    put(
        "ndcg_at_10.lift_over_keywords_same_text", None if lift is None else lift["ci95"][0], rated, with_baseline=False
    )
    put("ndcg_at_10.random", _mean(judged.random_values), rated, with_baseline=False)
    for name in ("without_fsp", "without_semantic"):
        computed = name in variants and rated > 0
        value = mean["ndcg_at_10"].get(name) if computed else None
        put(f"ndcg_at_10.{name}", value, rated if computed else 0, full, with_baseline=True)
    put("ndcg_at_10.ceiling_admitted", _mean(ceilings["ndcg_admitted"]), rated, full, with_baseline=True)
    put("precision_at_10.ceiling", _mean(ceilings["precision"]), rated, with_baseline=False)
    put("recall_at_10.ceiling", _mean(ceilings["recall"]), rated, with_baseline=False)
    put("recall_at_10.admitted", _mean(ceilings["recall_admitted"]), rated, with_baseline=False)
    needs = len(inputs.needs)
    put("needs_without_suitable", len(judged.without_suitable) / needs, needs, with_baseline=False)
    inflated, keywords = exposure["inflated_full"], exposure["inflated_keywords"]
    put("inflated_share_top10", _mean(inflated), len(inflated), _mean(keywords), with_baseline=True)
    top, everyone = exposure["fsp_top"], exposure["fsp_all"]
    put("without_fsp_share_top10", _mean(top), len(top), _mean(everyone), with_baseline=True)
    group_top, group_all = exposure["unconfirmed_top"], exposure["unconfirmed_all"]
    put("unconfirmed_share_top10", _mean(group_top), len(group_top), _mean(group_all), with_baseline=True)
    put(
        "precision_at_10.with_unconfirmed_tail",
        _mean(judged.with_tail),
        len(judged.with_tail),
        mean["precision_at_10"].get("full"),
        with_baseline=True,
    )
    return deltas


def evaluate(table: MetricTable, inputs: Inputs) -> dict[str, Any]:
    """The three checks over the needs of the split; rows into `table`, the report part returned."""
    pool = inputs.pool
    if not pool:
        raise ValueError("no person of the split holds a confirmed category: the pool is empty")
    variants = [name for name in VARIANTS if name in inputs.rankings]
    if inputs.semantic_used != ("without_semantic" in variants):
        raise ValueError("a run with semantic similarity ranks the variant without it, and only such a run does")
    judged = _judge(inputs, pool, variants)
    deltas = _put_whole(table, inputs, judged, variants)
    rated = len(judged.random_values)
    per_need, without_suitable = judged.per_need, judged.without_suitable
    conformance = _conformance(table, inputs, pool)
    sorting = _sorting(table, inputs, pool)
    false = _false_confirmations(table, inputs)
    return {
        "methodology": "v3",
        "needs": len(inputs.needs),
        "rated_needs": rated,
        "pool": len(pool),
        "semantic_used": inputs.semantic_used,
        "deltas": deltas,
        "without_suitable": _without_suitable(inputs, without_suitable),
        "slices": _slice_means(per_need),
        "conformance": conformance,
        "sorting": sorting,
        "false_confirmations": false,
        "per_need": per_need,
    }


def _without_suitable(inputs: Inputs, needs: Sequence[str]) -> dict[str, Any]:
    """The needs nobody of the pool is suitable for, by whether the need's role has a released test and whether the
    product's shortlist was empty."""
    by_id = {need.id: need for need in inputs.needs}
    counts: Counter[str] = Counter()
    for need_id in needs:
        tested = "tested_role" if admissible_categories(by_id[need_id]) else "role_without_test"
        empty = "empty_shortlist" if not inputs.rankings["full"][need_id] else "shortlist"
        counts[f"{tested}.{empty}"] += 1
    return {"needs": list(needs), "by_kind": dict(sorted(counts.items()))}


def _slice_means(per_need: Mapping[str, Mapping[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
    """Every measure of every system by every cut of the rated needs."""
    out: dict[str, dict[str, dict[str, Any]]] = {}
    rated = [row for row in per_need.values() if "ndcg_at_10" in row]
    for cut in ("role", "specialization", "grade_min", "lead", "format", "region", "salary", "fsp"):
        groups: dict[str, list[Mapping[str, Any]]] = {}
        for row in rated:
            groups.setdefault(row["slices"][cut], []).append(row)
        out[cut] = {
            value: {
                "n": len(rows),
                **{
                    measure: {name: _mean([row[measure][name] for row in rows]) for name in SYSTEMS}
                    for measure in MEASURES
                },
            }
            for value, rows in sorted(groups.items())
        }
    return out


def _conformance(table: MetricTable, inputs: Inputs, pool: Sequence[str]) -> dict[str, Any]:
    """(a): the rules of the task the shortlist must keep, counted against the world."""
    full = inputs.rankings["full"]
    uncategorized = [(nid, pid) for nid, order in full.items() for pid in order if pid not in inputs.categories]
    tested = sorted(set(inputs.categories) | {pid for pid, cats in inputs.product_categories.items() if cats})
    mismatched = []
    for pid in tested:
        expected = {inputs.categories[pid]} if pid in inputs.categories else set()
        held = {(spec, grade) for spec, grade, _ in inputs.product_categories.get(pid, ())}
        if held != expected:
            mismatched.append({"profile_id": pid, "expected": sorted(expected), "product": sorted(held)})
    outside, positions = [], 0
    wrong_categories, missed_categories = [], []
    for need in inputs.needs:
        admissible = admissible_categories(need)
        for pid in full[need.id][:K]:
            positions += 1
            if inputs.categories.get(pid) not in admissible:
                outside.append((need.id, pid))
        chosen = inputs.product_needs[need.id].categories
        if chosen - admissible:
            wrong_categories.append({"need": need.id, "role": need.role, "extra": sorted(chosen - admissible)})
        if admissible - chosen:
            missed_categories.append({"need": need.id, "role": need.role, "missed": sorted(admissible - chosen)})
    pairs = held = 0
    beyond: Counter[str] = Counter()
    for pid in pool:
        truth = set(inputs.truths[pid].skills)
        for _, _, skills in inputs.product_categories.get(pid, ()):
            for skill in skills & VOCABULARY:
                pairs += 1
                held += skill in truth
                if skill not in truth:
                    beyond[skill] += 1

    def put(key: str, value: float | None, n: int) -> None:
        table.put(f"{GROUP}.tz.{key}", value, n, with_baseline=False)

    put("uncategorized_positions", len(uncategorized), sum(len(order) for order in full.values()))
    put("category_mismatch", len(mismatched), len(tested))
    put("outside_need_categories", len(outside) / positions if positions else None, positions)
    put("confirmation_consistency", held / pairs if pairs else None, pairs)
    return {
        "uncategorized_positions": uncategorized,
        "category_mismatch": mismatched,
        "outside_need_categories": len(outside),
        "needs_with_extra_categories": wrong_categories,
        "needs_with_missed_categories": missed_categories,
        "confirmed_not_held": dict(beyond.most_common()),
    }


def admissible_set_of(need: Vacancy, categories: Mapping[str, tuple[str, str]]) -> list[str]:
    """(c): the people of the pool holding a category the need admits — fixed by the world before the run."""
    admissible = admissible_categories(need)
    return sorted(pid for pid, category in categories.items() if category in admissible)


def _sorting(table: MetricTable, inputs: Inputs, pool: Sequence[str]) -> dict[str, Any]:
    """(c): the product's order and the keyword sorting of the product's own requirements over the admissible set."""
    sorting = inputs.rankings.get("sorting", {})
    values: dict[str, dict[str, list[float]]] = {m: {"product": [], "keywords": []} for m in MEASURES}
    for need in inputs.needs:
        people = admissible_set_of(need, inputs.categories)
        rels = {pid: relevance(need, inputs.truths[pid]) for pid in people}
        if not any(rel >= SUITABLE for rel in rels.values()):
            continue
        order = list(sorting[need.id])
        if sorted(order) != sorted(people):
            raise ValueError(f"need {need.id}: the sorting ranked other people than the admissible set")
        keywords = baseline_orders(inputs, need, people)["keywords_same_requirements"]
        for measure, function in MEASURES.items():
            values[measure]["product"].append(function(order, rels))
            values[measure]["keywords"].append(function(keywords, rels))
    n = len(values["ndcg_at_10"]["product"])
    deltas = {measure: paired_delta(inputs.seed, by["product"], by["keywords"]) for measure, by in values.items() if n}
    for measure in ("ndcg_at_10", "precision_at_10", "mrr"):
        by = values[measure]
        table.put(
            f"{GROUP}.sorting.{measure}",
            _mean(by["product"]),
            n,
            _mean(by["keywords"]),
            with_baseline=True,
        )
        table.put(
            f"{GROUP}.sorting.{measure}.keywords_same_requirements", _mean(by["keywords"]), n, with_baseline=False
        )
    lift = deltas.get("ndcg_at_10")
    table.put(
        f"{GROUP}.sorting.ndcg_at_10.lift_over_keywords_same_requirements",
        None if lift is None else lift["ci95"][0],
        n,
        with_baseline=False,
    )
    return {"needs": n, "deltas": deltas}


def _false_confirmations(table: MetricTable, inputs: Inputs) -> dict[str, Any]:
    """The scenario of false confirmations: the pool with the people it confirms, ranked by the variant of the
    scenario; how high the falsely confirmed rise in the product's first ten against the same-text keyword search."""
    ranking = inputs.rankings.get("false_confirmations")
    if ranking is None:
        raise ValueError("the run has no ranking of the scenario of false confirmations")
    pool = sorted(set(inputs.categories) | set(inputs.false_categories))
    false = set(inputs.false_categories)
    ndcgs: dict[str, list[float]] = {"product": [], "keywords": []}
    shares: dict[str, list[float]] = {"product": [], "keywords": []}
    for need in inputs.needs:
        rels = {pid: relevance(need, inputs.truths[pid]) for pid in pool}
        order = list(ranking[need.id])
        keywords = bm25_order(need_text(need), {pid: inputs.texts.get(pid) for pid in pool}, inputs.seed, need.id)
        if order:
            shares["product"].append(sum(pid in false for pid in order[:K]) / len(order[:K]))
            shares["keywords"].append(sum(pid in false for pid in keywords[:K]) / len(keywords[:K]))
        if any(rel >= SUITABLE for rel in rels.values()):
            ndcgs["product"].append(ndcg(order, rels))
            ndcgs["keywords"].append(ndcg(keywords, rels))
    table.put(
        f"{GROUP}.false_confirmed.ndcg_at_10",
        _mean(ndcgs["product"]),
        len(ndcgs["product"]),
        _mean(ndcgs["keywords"]),
        with_baseline=True,
    )
    table.put(
        f"{GROUP}.false_confirmed.share_top10",
        _mean(shares["product"]),
        len(shares["product"]),
        _mean(shares["keywords"]),
        with_baseline=True,
    )
    return {"people": len(false), "pool": len(pool)}
