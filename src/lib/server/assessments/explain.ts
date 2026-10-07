// The explanation of a grade decision to the candidate (docs/domain.md, 10.6; ч. 3 ст. 16 152-ФЗ): from the stored
// decision, without recomputing — the outcome and its reason in words, the score S against the cut C of the items
// served (stored in twentieths, shown in points), every block with its items, score, cut and verdict, whether a defining
// block passed, the practice with its gate, what the test does not check. Answers and keys of the hidden items are not
// part of it.
import {
	CATALOG,
	blockDefinition,
	gradeDefinition,
	type GradeKey,
	type SpecializationKey
} from './contract/catalog.ts';
import type { JudgementProvenance } from './contract/bank.ts';
import { SCALE, type BlockSummary, type DecisionOutcome, type DecisionReason } from './contract/procedure.ts';

export const OUTCOME_TITLES: Record<DecisionOutcome, string> = {
	confirmed: 'Грейд подтверждён',
	not_confirmed: 'Грейд не подтверждён',
	undetermined: 'Не определено'
};

export const REASON_TEXTS: Record<DecisionReason, string> = {
	sprt_upper: 'Последовательная проверка уверенно показала уровень выше порога.',
	sprt_lower: 'Последовательная проверка уверенно показала уровень ниже порога.',
	forced_upper_at_max: 'Основная часть теста закончилась с баллом выше полосы неопределённости.',
	forced_lower_at_max: 'Основная часть теста закончилась с баллом ниже полосы неопределённости.',
	forced_upper_final: 'После продления балл оказался выше полосы неопределённости.',
	forced_lower_final: 'После продления балл оказался ниже полосы неопределённости.',
	band_after_extension:
		'После продления балл остался в полосе неопределённости — тест не может решить ни в одну сторону.',
	practice_gate_failed: 'Практическая задача решена ниже её порога — тест остановлен на ней.',
	defining_block_failed:
		'Сумма баллов выше порога, но определяющий блок грейда провален: без него грейд не подтверждается.',
	bank_exhausted:
		'Для следующего задания не нашлось новых для вас вариантов — это не провал и не засчитывается как попытка.',
	rescored_incomplete:
		'После пересмотра баллов поданных заданий не хватило для решения — это не провал и не засчитывается как попытка.'
};

/**
 * The label a result carries while its clusters were judged by models only (domain 10.8): rubrics approved only by
 * independent models, cuts from model ratings only, and whether a judging model is of the vendor of the authoring one.
 * `null` — every cluster was signed by a person.
 */
export function judgementNote(judgement: JudgementProvenance): string | null {
	const note = judgementBasis(judgement);
	if (note === null) return null;
	return judgement.sameVendorReviewer
		? `${note}; одна из моделей-рецензентов — того же поставщика, что автор заданий.`
		: `${note}.`;
}

function judgementBasis({ rubricByModelsOnly, angoffProvisional }: JudgementProvenance): string | null {
	if (rubricByModelsOnly && angoffProvisional) {
		return 'Рубрики заданий проверены независимыми моделями, пороги предварительные — их подтверждают эксперты';
	}
	if (rubricByModelsOnly) return 'Рубрики заданий проверены независимыми моделями — их подтверждают эксперты';
	if (angoffProvisional) return 'Пороги заданий предварительные — их подтверждают эксперты';
	return null;
}

export const BLOCK_VERDICTS: Record<BlockSummary['verdict'], string> = {
	above: 'выше порога',
	at: 'на уровне порога',
	below: 'ниже порога'
};

export interface StoredDecision {
	specialization: SpecializationKey;
	grade: GradeKey;
	outcome: DecisionOutcome;
	reason: DecisionReason;
	confident: boolean;
	/** Sums in twentieths, as the procedure keeps them. */
	scoreSum: number;
	cutSum: number;
	items: number;
	extensionUsed: boolean;
	practice: { score: number; gateMinScore: number; passed: boolean } | null;
	blocks: readonly BlockSummary[];
}

export interface Explanation {
	title: string;
	reason: string;
	summary: string;
	confident: boolean;
	blocks: {
		code: string;
		title: string;
		checks: string;
		items: number;
		/** In points. */
		score: number;
		cut: number;
		verdict: string;
		defining: boolean;
		passed: boolean;
	}[];
	/** `null` — the attempt ended before its practice (the bank ran out). */
	practice: { title: string; score: number; gateMinScore: number; passed: boolean } | null;
	doesNotCheck: string[];
}

const number = (value: number): string => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

export function explainDecision(decision: StoredDecision): Explanation {
	const definition = gradeDefinition(decision.specialization, decision.grade);
	return {
		title: OUTCOME_TITLES[decision.outcome],
		reason: REASON_TEXTS[decision.reason],
		summary:
			`Набрано ${number(decision.scoreSum / SCALE)} при пороге ${number(decision.cutSum / SCALE)} по ` +
			`${decision.items} заданиям${decision.extensionUsed ? ' (с продлением)' : ''}. Порог — сумма оценок ` +
			'пограничного кандидата по тем заданиям, что вам достались; практическая задача в сумму не входит — она ворота.',
		confident: decision.confident,
		blocks: decision.blocks.map((block) => {
			const spec = blockDefinition(block.block);
			return {
				code: block.block,
				title: spec.title,
				checks: spec.checks,
				items: block.items,
				score: block.score / SCALE,
				cut: block.cut / SCALE,
				verdict: BLOCK_VERDICTS[block.verdict],
				defining: block.defining,
				passed: block.passed
			};
		}),
		practice: decision.practice && {
			title: blockDefinition(definition.practice.block).title,
			score: decision.practice.score,
			gateMinScore: decision.practice.gateMinScore,
			passed: decision.practice.passed
		},
		doesNotCheck: [...CATALOG.commonDoesNotCheck, ...definition.doesNotCheck]
	};
}
