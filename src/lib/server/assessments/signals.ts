// Journal of attempt signals (docs/domain.md, 10.7 `integrity_signals`): time spent, pastes, leaving the page, an answer
// right for another candidate's instance (`leak.ts`). The FSP operator who reviews the attempt reads the journal whole
// and the candidate sees it as it is; a company that sees the candidate's card gets only its totals for the attempt that
// assigned each category in force (`SignalSummary`), never the entries or the timings of single items. They never decide anything automatically — the test does not read them —
// and are not a detection of borrowed or generated code: the platform does not claim one.
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '$lib/server/db';
import { gradeDecisions, testAttempts } from '$lib/server/db/schema';

const count = z.int().min(0).max(100_000);

/** What the page reports with an answer or a submission; bounded so a crafted form cannot bloat the attempt. */
export const clientSignalsSchema = z.strictObject({
	elapsedMs: z.int().min(0).max(86_400_000),
	pasteCount: count,
	pastedChars: z.int().min(0).max(10_000_000),
	blurCount: count
});
export type ClientSignals = z.infer<typeof clientSignalsSchema>;

const entrySchema = z.strictObject({
	at: z.iso.datetime(),
	/** An answer to a computed item, a program or test cases, or the step «измени своё решение». */
	stage: z.enum(['answer', 'submission', 'change_step']),
	/** The slot of the item. */
	seq: z.int().min(1),
	/** From showing the question to the answer, measured by the server. */
	responseMs: z.int().min(0).optional(),
	/** `null` — the page sent no signals (scripts off or an old page). */
	client: clientSignalsSchema.nullable(),
	/**
	 * The answer was wrong for the candidate's instance but right for exactly one instance of the same family served to
	 * another candidate (`leak.ts`): its class, and whether it is the candidate's class. Never the other attempt.
	 */
	foreignAnswer: z.strictObject({ classId: z.string().min(1).max(64), sameClass: z.boolean() }).optional()
});
export type SignalEntry = z.infer<typeof entrySchema>;

const logSchema = z.strictObject({ entries: z.array(entrySchema) });
export type SignalLog = z.infer<typeof logSchema>;

export function parseSignalLog(value: unknown): SignalLog {
	return value === null ? { entries: [] } : logSchema.parse(value);
}

export function appendSignal(value: unknown, entry: SignalEntry): SignalLog {
	const log = parseSignalLog(value);
	return { entries: [...log.entries, entrySchema.parse(entry)] };
}

/** Signals from a form field: absent or empty — `null`; present but malformed — a refusal of the request. */
export function readClientSignals(raw: string | null): ClientSignals | null | 'invalid' {
	if (raw === null || raw.trim() === '') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return 'invalid';
	}
	const result = clientSignalsSchema.safeParse(parsed);
	return result.success ? result.data : 'invalid';
}

/** Totals of the journal: what the operator looks at first and all a company sees of it. */
export interface SignalSummary {
	/** Entries of the journal: answers, submissions and change steps. */
	entries: number;
	pastes: number;
	pastedChars: number;
	departures: number;
	/** Entries whose page sent no signals (scripts off). */
	silent: number;
	/** Wrong answers that are the right answer of another candidate's instance. */
	foreignAnswers: number;
}

export function summarizeSignals(log: SignalLog): SignalSummary {
	const summary: SignalSummary = {
		entries: log.entries.length,
		pastes: 0,
		pastedChars: 0,
		departures: 0,
		silent: 0,
		foreignAnswers: 0
	};
	for (const entry of log.entries) {
		if (entry.foreignAnswer) summary.foreignAnswers++;
		if (entry.client === null) {
			summary.silent++;
			continue;
		}
		summary.pastes += entry.client.pasteCount;
		summary.pastedChars += entry.client.pastedChars;
		summary.departures += entry.client.blurCount;
	}
	return summary;
}

/** The totals of the signal journal of the attempt that assigned a category in force. */
export interface CategorySignals {
	specialization: string;
	grade: string;
	summary: SignalSummary;
}

/**
 * The totals of the deciding attempt of each category given, in its order — the same for the card a company sees and
 * for the candidate's own screen of categories.
 */
export async function categorySignals(
	executor: Executor,
	categories: readonly { specialization: string; grade: string; decisionId: string }[]
): Promise<CategorySignals[]> {
	if (categories.length === 0) return [];
	const rows = await executor
		.select({ decisionId: gradeDecisions.id, signals: testAttempts.integritySignals })
		.from(gradeDecisions)
		.innerJoin(testAttempts, eq(testAttempts.id, gradeDecisions.attemptId))
		.where(
			inArray(
				gradeDecisions.id,
				categories.map((category) => category.decisionId)
			)
		);
	const journals = new Map(rows.map((row) => [row.decisionId, row.signals]));
	return categories.map((category) => {
		if (!journals.has(category.decisionId)) {
			throw new Error(`the grade decision ${category.decisionId} of a category has no attempt`);
		}
		return {
			specialization: category.specialization,
			grade: category.grade,
			summary: summarizeSignals(parseSignalLog(journals.get(category.decisionId)))
		};
	});
}
