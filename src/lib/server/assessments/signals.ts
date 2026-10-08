// Journal of attempt signals (docs/domain.md, 10.7 `integrity_signals`): time spent, pastes, leaving the page. They
// are kept for the FSP operator who reviews the attempt and are shown to the candidate as they are; an employer never
// sees them. They never decide anything automatically and are not a detection of borrowed or generated
// code: the platform does not claim one.
import { z } from 'zod';

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
	client: clientSignalsSchema.nullable()
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
