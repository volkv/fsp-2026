// «Оцените подбор» (docs/contracts.md, section 10.2, item 10): the company — or an expert of the jury in a demo session
// — sees the top ten of the shortlist and the top ten of a plain keyword search for the same need merged by team-draft
// interleaving and shuffled, in one of two parts, each named as such: the comparison on the confirmed pool — the
// keyword search among the candidates of the shortlist's categories and filters, the same conditions as the shortlist,
// against the shortlist's confirmed candidates (its group «грейд не подтверждён» is not of the pool);
// the experiment over the whole catalog — the keyword search over everyone the company sees, candidates without a
// category included, «эксперимент, не качество подборки»; without which system put a card there, and marks the candidates who fit. The judgement
// gives Precision@10 of each system (out of ten: a short list does not count higher), the preference by the interleaving
// credits and the share of candidates without FSP results in each top ten. Until it is judged the evaluation names the
// shown candidates by the company's pseudonyms; the judgement removes them and keeps only which system put each card
// where and whether it was chosen.
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { auditActorOf } from '$lib/server/companies/context';
import { candidates, EVALUATION_SCOPES, shortlistEvaluations, sourceFacts } from '$lib/server/db/schema';
import { listedInCatalog } from '$lib/server/db/conditions';
import { currentVocabulary } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { keywordSearch, visibleAmong } from '$lib/server/matching/search';
import { uuidv7 } from '$lib/server/ids';
import { searchOf } from './query';
import { needMatchOf, rankStep, shortlistStep, type ShortlistDeps } from './service';

export const TOP = 10;

export type EvaluationScope = (typeof EVALUATION_SCOPES)[number];

const cardSchema = z.strictObject({
	position: z.int().positive(),
	/** The system whose pick the card was in the interleaving. */
	team: z.enum(['product', 'keywords']),
	product_rank: z.int().positive().nullable(),
	keyword_rank: z.int().positive().nullable(),
	fsp: z.boolean(),
	/** The company's pseudonym of the candidate, until the judgement. */
	pseudonym: z.string().nullable()
});
const cardsSchema = z.array(cardSchema);
export type EvaluationCard = z.infer<typeof cardSchema>;

export interface EvaluationResult {
	selected: number;
	precision_at_10: { product: number; keywords: number };
	/** Chosen cards credited to each system by the interleaving; the winner has more. */
	preference: { product: number; keywords: number; winner: 'product' | 'keywords' | 'tie' };
	/** Share of candidates without FSP results in each top ten (`null` — an empty list). */
	without_fsp_top10: { product: number | null; keywords: number | null };
	/** Cards both systems had in their top ten. */
	overlap: number;
}

/** A deterministic generator from a seed: the interleaving and the shuffle of one evaluation can be replayed. */
function random(seed: string): () => number {
	let counter = 0;
	return () => {
		const digest = createHash('sha256').update(`${seed}:${counter++}`).digest();
		return digest.readUInt32BE(0) / 0x1_0000_0000;
	};
}

/**
 * Team-draft interleaving (Radlinski et al., CIKM 2008): in each round the system with fewer picks — a coin decides a
 * tie — adds its best candidate not yet taken; each card is credited to the system that picked it. Then the shown order
 * is shuffled, so the position tells nothing about the system.
 */
export function interleave(
	product: readonly string[],
	keywords: readonly string[],
	seed: string
): { id: string; team: 'product' | 'keywords' }[] {
	const next = random(seed);
	const taken = new Set<string>();
	const picks: { id: string; team: 'product' | 'keywords' }[] = [];
	const counts = { product: 0, keywords: 0 };
	const firstFree = (list: readonly string[]) => list.find((id) => !taken.has(id));
	for (;;) {
		const a = firstFree(product);
		const b = firstFree(keywords);
		if (a === undefined && b === undefined) break;
		let team: 'product' | 'keywords';
		if (a === undefined) team = 'keywords';
		else if (b === undefined) team = 'product';
		else if (counts.product !== counts.keywords) team = counts.product < counts.keywords ? 'product' : 'keywords';
		else team = next() < 0.5 ? 'product' : 'keywords';
		const id = team === 'product' ? a : b;
		if (id === undefined) throw new Error('the interleaving picked from an exhausted list');
		taken.add(id);
		counts[team]++;
		picks.push({ id, team });
	}
	for (let i = picks.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[picks[i], picks[j]] = [picks[j] as (typeof picks)[number], picks[i] as (typeof picks)[number]];
	}
	return picks;
}

/** The judgement over the cards: pure, so the counting is checked apart from the pages. */
export function judge(cards: readonly EvaluationCard[], selected: ReadonlySet<number>): EvaluationResult {
	const chosen = cards.filter((card) => selected.has(card.position));
	const hits = (rank: 'product_rank' | 'keyword_rank') => chosen.filter((card) => card[rank] !== null).length;
	const credits = {
		product: chosen.filter((card) => card.team === 'product').length,
		keywords: chosen.filter((card) => card.team === 'keywords').length
	};
	const withoutFsp = (rank: 'product_rank' | 'keyword_rank') => {
		const top = cards.filter((card) => card[rank] !== null);
		return top.length === 0 ? null : Math.round((top.filter((card) => !card.fsp).length / top.length) * 1000) / 1000;
	};
	return {
		selected: chosen.length,
		precision_at_10: { product: hits('product_rank') / TOP, keywords: hits('keyword_rank') / TOP },
		preference: {
			...credits,
			winner: credits.product === credits.keywords ? 'tie' : credits.product > credits.keywords ? 'product' : 'keywords'
		},
		without_fsp_top10: { product: withoutFsp('product_rank'), keywords: withoutFsp('keyword_rank') },
		overlap: cards.filter((card) => card.product_rank !== null && card.keyword_rank !== null).length
	};
}

/** The words of the keyword search: the names of the need's skills, any of them; without skills — its text. */
async function keywordsOf(
	deps: ShortlistDeps,
	form: { skill_keys: string[]; nice_skill_keys: string[] },
	text: string | null
) {
	const keys = [...form.skill_keys, ...form.nice_skill_keys];
	if (keys.length === 0) return text;
	const names = new Map((await currentVocabulary(deps.db)).skills.map(({ key, name }) => [key, name]));
	return keys.map((key) => names.get(key) ?? key).join(' or ');
}

export interface StartedEvaluation {
	id: string;
	/** Cards in the shown order, with the server-side key of each candidate for its card. */
	cards: { position: number; pseudonym: string; candidateId: string }[];
}

/**
 * A new blind comparison on the latest step of the shortlist, in the scope asked for. On the confirmed pool a step
 * without categories has no pool: nothing to compare.
 */
export async function startEvaluation(
	deps: ShortlistDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	shortlistId: string,
	scope: EvaluationScope,
	signal?: AbortSignal
): Promise<StartedEvaluation> {
	const { shortlist, step, needText } = await shortlistStep(deps, subject, shortlistId);
	const membership = subject.membership;
	if (!membership) throw new ApiError('forbidden');
	// On the confirmed pool both systems pick from the holders of the step's categories: the group «грейд не
	// подтверждён» stays out of the ten, as it stays out of the pool of the keyword search.
	const ranked = (await rankStep(deps, subject, { id: shortlistId, needText }, step, signal)).ranked;
	const product = (
		scope === 'confirmed_pool' ? ranked.filter((item) => needMatchOf(item).group === 'confirmed') : ranked
	).slice(0, TOP);
	const words = await keywordsOf(deps, step.query.form, needText);
	const pool =
		scope === 'confirmed_pool' ? searchOf(step.query, needText, { id: shortlistId, revision: step.seq }) : null;
	const keywords =
		words === null || (pool !== null && step.query.categories.length === 0)
			? []
			: await keywordSearch(deps, subject, words, TOP, pool?.filters ?? {});
	if (product.length === 0 && keywords.length === 0) {
		throw new ApiError('conflict', {
			details: [{ code: 'nothing_to_compare', message: 'Ни подборка, ни поиск по словам никого не нашли' }]
		});
	}
	const id = uuidv7();
	const productRank = new Map(product.map((item, index) => [item.candidateId, index + 1]));
	const keywordRank = new Map(keywords.map((item, index) => [item.candidateId, index + 1]));
	const pseudonymOf = new Map([...product, ...keywords].map((item) => [item.candidateId, item.pseudonym]));
	const picks = interleave(
		product.map((item) => item.candidateId),
		keywords.map((item) => item.candidateId),
		id
	);
	const fsp = new Set(
		(
			await deps.db
				.selectDistinct({ id: sourceFacts.candidateId })
				.from(sourceFacts)
				.where(
					and(
						inArray(
							sourceFacts.candidateId,
							picks.map((pick) => pick.id)
						),
						eq(sourceFacts.source, 'fsp'),
						eq(sourceFacts.status, 'active')
					)
				)
		).map((row) => row.id)
	);
	const cards: EvaluationCard[] = picks.map((pick, index) => ({
		position: index + 1,
		team: pick.team,
		product_rank: productRank.get(pick.id) ?? null,
		keyword_rank: keywordRank.get(pick.id) ?? null,
		fsp: fsp.has(pick.id),
		pseudonym: pseudonymOf.get(pick.id) ?? null
	}));
	await deps.db.transaction(async (tx) => {
		await tx.insert(shortlistEvaluations).values({
			id,
			shortlistId: shortlist.id,
			revisionSeq: step.seq,
			scope,
			createdByMemberId: membership.memberId,
			cards
		});
		await recordAuditEvent(tx, {
			action: 'shortlist.evaluated',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'shortlist', id: shortlist.id },
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { evaluation_id: id, stage: 'started', scope, cards: cards.length }
		});
	});
	return {
		id,
		cards: picks.map((pick, index) => ({
			position: index + 1,
			pseudonym: pseudonymOf.get(pick.id) ?? '',
			candidateId: pick.id
		}))
	};
}

async function ownEvaluation(deps: ShortlistDeps, subject: AccessSubject, shortlistId: string, evaluationId: string) {
	await shortlistStep(deps, subject, shortlistId);
	const [row] = await deps.db
		.select()
		.from(shortlistEvaluations)
		.where(and(eq(shortlistEvaluations.id, evaluationId), eq(shortlistEvaluations.shortlistId, shortlistId)));
	if (!row) throw new ApiError('not_found');
	return { row, cards: cardsSchema.parse(row.cards) };
}

/**
 * The cards of an evaluation not yet judged, for its page: each pseudonym found among the candidates the company sees
 * now; one it no longer sees is shown as unavailable and cannot be chosen.
 */
export async function openEvaluation(
	deps: ShortlistDeps,
	subject: AccessSubject,
	shortlistId: string,
	evaluationId: string
): Promise<{
	scope: EvaluationScope;
	judged: EvaluationResult | null;
	cards: { position: number; pseudonym: string | null; candidateId: string | null }[];
}> {
	const { row, cards } = await ownEvaluation(deps, subject, shortlistId, evaluationId);
	if (row.result !== null) {
		return {
			scope: row.scope,
			judged: row.result as EvaluationResult,
			cards: cards.map((card) => ({ position: card.position, pseudonym: null, candidateId: null }))
		};
	}
	const membership = subject.membership;
	if (!membership) throw new ApiError('forbidden');
	const wanted = new Set(cards.flatMap((card) => (card.pseudonym === null ? [] : [card.pseudonym])));
	const listed = await deps.db.select({ id: candidates.id }).from(candidates).where(listedInCatalog(candidates));
	const named = listed.filter((row) => wanted.has(deps.pseudonym(row.id, membership.companyId)));
	const visible = await visibleAmong(
		deps,
		subject,
		named.map((row) => row.id)
	);
	const byPseudonym = new Map([...visible].map(([id, pseudonym]) => [pseudonym, id]));
	return {
		scope: row.scope,
		judged: null,
		cards: cards.map((card) => ({
			position: card.position,
			pseudonym: card.pseudonym,
			candidateId: card.pseudonym === null ? null : (byPseudonym.get(card.pseudonym) ?? null)
		}))
	};
}

/** The judgement: the positions of the chosen cards. The pseudonyms are removed; the result is kept. */
export async function judgeEvaluation(
	deps: ShortlistDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	shortlistId: string,
	evaluationId: string,
	positions: readonly number[]
): Promise<EvaluationResult> {
	const { row, cards } = await ownEvaluation(deps, subject, shortlistId, evaluationId);
	if (row.result !== null) {
		throw new ApiError('conflict', { details: [{ code: 'already_judged', message: 'Оценка уже сохранена' }] });
	}
	const known = new Set(cards.map((card) => card.position));
	const selected = new Set(positions);
	if (selected.size !== positions.length || positions.some((position) => !known.has(position))) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'selected', code: 'invalid', message: 'Отметьте карточки этой оценки, без повторов' }]
		});
	}
	const result = judge(cards, selected);
	const now = deps.now();
	await deps.db.transaction(async (tx) => {
		const [updated] = await tx
			.update(shortlistEvaluations)
			.set({ cards: cards.map((card) => ({ ...card, pseudonym: null })), result, judgedAt: now })
			.where(and(eq(shortlistEvaluations.id, evaluationId), eq(shortlistEvaluations.shortlistId, shortlistId)))
			.returning({ id: shortlistEvaluations.id });
		if (!updated) throw new Error(`evaluation ${evaluationId} disappeared`);
		await recordAuditEvent(tx, {
			action: 'shortlist.evaluated',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'shortlist', id: shortlistId },
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { evaluation_id: evaluationId, stage: 'judged', selected: result.selected }
		});
	});
	return result;
}

interface EvaluationMean {
	precision_at_10: { product: number; keywords: number };
	product_wins: number;
	keyword_wins: number;
	count: number;
}

export interface EvaluationSummary {
	judged: { id: string; scope: EvaluationScope; revision: number; judgedAt: Date; result: EvaluationResult }[];
	/** Means over the judged evaluations of each scope, never mixed; `null` — none judged in it. */
	mean: Record<EvaluationScope, EvaluationMean | null>;
}

/** The judged evaluations of the shortlist, newest first, with the means of each scope apart. */
export async function evaluationSummary(
	deps: ShortlistDeps,
	subject: AccessSubject,
	shortlistId: string
): Promise<EvaluationSummary> {
	await shortlistStep(deps, subject, shortlistId);
	const rows = await deps.db
		.select()
		.from(shortlistEvaluations)
		.where(and(eq(shortlistEvaluations.shortlistId, shortlistId), isNotNull(shortlistEvaluations.judgedAt)))
		.orderBy(desc(shortlistEvaluations.judgedAt));
	const judged = rows.map((row) => {
		if (row.judgedAt === null || row.result === null) throw new Error('a judged evaluation without its result');
		return {
			id: row.id,
			scope: row.scope,
			revision: row.revisionSeq,
			judgedAt: row.judgedAt,
			result: row.result as EvaluationResult
		};
	});
	const meanOf = (scope: EvaluationScope): EvaluationMean | null => {
		const of = judged.filter((j) => j.scope === scope);
		if (of.length === 0) return null;
		const mean = (pick: (r: EvaluationResult) => number) =>
			Math.round((of.reduce((sum, j) => sum + pick(j.result), 0) / of.length) * 1000) / 1000;
		return {
			precision_at_10: {
				product: mean((r) => r.precision_at_10.product),
				keywords: mean((r) => r.precision_at_10.keywords)
			},
			product_wins: of.filter((j) => j.result.preference.winner === 'product').length,
			keyword_wins: of.filter((j) => j.result.preference.winner === 'keywords').length,
			count: of.length
		};
	};
	return { judged, mean: { confirmed_pool: meanOf('confirmed_pool'), whole_catalog: meanOf('whole_catalog') } };
}
