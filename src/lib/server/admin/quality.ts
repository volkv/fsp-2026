// The quality panel reads concrete evaluation runs (domain 16.4): the page shows the numbers of one run with its
// dataset, versions and thresholds set before the run, never numbers of its own. The run rows are written by the
// evaluation harness in the format read here:
//   metrics    — { "<group>.<metric>[.<variant>]": { value: number | null, baseline?: number | null, n?: int } }
//   thresholds — { "<same key>": { min?: number, max?: number } }
//   versions   — { "<component>": string | number | object } (models, rules, taxonomy, embedding space, docparse)
// A row in another format is shown as such, with what exactly does not fit.
import { count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ActionContext } from '$lib/server/companies/context';
import { requirePermission } from '$lib/server/companies/context';
import type { Executor } from '$lib/server/db';
import { evalRuns, files } from '$lib/server/db/schema';

const metricSchema = z.strictObject({
	value: z.number().nullable(),
	baseline: z.number().nullable().optional(),
	/** Items the metric was computed on. */
	n: z.int().nonnegative().optional()
});

const thresholdSchema = z
	.strictObject({ min: z.number().optional(), max: z.number().optional() })
	.refine((t) => t.min !== undefined || t.max !== undefined, 'a threshold needs min or max');

const metricKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'a metric key is <group>.<metric>[.<variant>]');

export const runMetricsSchema = z.record(metricKey, metricSchema);
export const runThresholdsSchema = z.record(metricKey, thresholdSchema);

/**
 * `missing` — a threshold is set and the run did not compute the metric: a failure like `fail`, since the bar was not
 * shown to be met; `no_value` — not computed and no threshold.
 */
export type MetricStatus = 'pass' | 'fail' | 'missing' | 'no_threshold' | 'no_value';

export interface MetricRow {
	key: string;
	group: string;
	value: number | null;
	baseline: number | null;
	/** `value - baseline` when both are known. */
	delta: number | null;
	n: number | null;
	threshold: { min: number | null; max: number | null } | null;
	status: MetricStatus;
}

export interface MetricGroup {
	key: string;
	metrics: MetricRow[];
	/** Metrics of the group outside their thresholds or not computed at one. */
	failed: number;
}

/** Each metric against its threshold and its baseline; groups keep the order of the model (domain 16.4). */
export function evaluateMetrics(
	metrics: z.infer<typeof runMetricsSchema>,
	thresholds: z.infer<typeof runThresholdsSchema>
): MetricGroup[] {
	const rows = Object.entries(metrics).map(([key, metric]): MetricRow => {
		const limit = thresholds[key];
		const threshold = limit ? { min: limit.min ?? null, max: limit.max ?? null } : null;
		const value = metric.value;
		const baseline = metric.baseline ?? null;
		let status: MetricStatus;
		if (value === null) status = threshold === null ? 'no_value' : 'missing';
		else if (threshold === null) status = 'no_threshold';
		else
			status =
				(threshold.min === null || value >= threshold.min) && (threshold.max === null || value <= threshold.max)
					? 'pass'
					: 'fail';
		return {
			key,
			group: key.slice(0, key.indexOf('.')),
			value,
			baseline,
			delta: value !== null && baseline !== null ? value - baseline : null,
			n: metric.n ?? null,
			threshold,
			status
		};
	});
	const order = ['resume', 'skills', 'categorization', 'matching', 'performance'];
	const groups = new Map<string, MetricRow[]>();
	for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
	const rank = (group: string) => {
		const index = order.indexOf(group);
		return index === -1 ? order.length : index;
	};
	return [...groups.entries()]
		.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
		.map(([key, metrics]) => ({
			key,
			metrics,
			failed: metrics.filter((m) => m.status === 'fail' || m.status === 'missing').length
		}));
}

export interface VersionLine {
	component: string;
	value: string;
}

function versionLines(versions: unknown): VersionLine[] {
	if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) return [];
	return Object.entries(versions).map(([component, value]) => ({
		component,
		value: typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value)
	}));
}

export interface EvalRunSummary {
	id: string;
	createdAt: Date;
	productRevision: string;
	datasetId: string;
	datasetSize: number;
	datasetProvenance: 'synthetic' | 'manual_labeled' | 'customer';
	split: string;
	processingMode: 'model' | 'rules_only' | 'partial' | 'failed';
}

export interface EvalRunView extends EvalRunSummary {
	versions: VersionLine[];
	/** `null` with `formatProblem` — the row does not follow the format the panel reads. */
	groups: MetricGroup[] | null;
	formatProblem: string | null;
	report: { fileId: string; name: string; sizeBytes: number; sha256: string; status: string } | null;
}

export interface QualityPanel {
	run: EvalRunView | null;
	history: (EvalRunSummary & { failed: number | null; metricCount: number | null })[];
	total: number;
}

const HISTORY_SHOWN = 20;

const summaryColumns = {
	id: evalRuns.id,
	createdAt: evalRuns.createdAt,
	productRevision: evalRuns.productRevision,
	datasetId: evalRuns.datasetId,
	datasetSize: evalRuns.datasetSize,
	datasetProvenance: evalRuns.datasetProvenance,
	split: evalRuns.split,
	processingMode: evalRuns.processingMode
};

function problemOf(error: z.ZodError, field: string): string {
	const [issue] = error.issues;
	const path = issue ? issue.path.map(String).join('.') : '';
	return `${field}${path ? ` → ${path}` : ''}: ${issue?.message ?? 'не распознано'}`;
}

function evaluateRow(metrics: unknown, thresholds: unknown): Pick<EvalRunView, 'groups' | 'formatProblem'> {
	const parsedMetrics = runMetricsSchema.safeParse(metrics);
	if (!parsedMetrics.success) return { groups: null, formatProblem: problemOf(parsedMetrics.error, 'metrics') };
	const parsedThresholds = runThresholdsSchema.safeParse(thresholds);
	if (!parsedThresholds.success) {
		return { groups: null, formatProblem: problemOf(parsedThresholds.error, 'thresholds') };
	}
	return { groups: evaluateMetrics(parsedMetrics.data, parsedThresholds.data), formatProblem: null };
}

async function runView(executor: Executor, id: string | null): Promise<EvalRunView | null> {
	const query = executor
		.select({
			...summaryColumns,
			versions: evalRuns.versions,
			metrics: evalRuns.metrics,
			thresholds: evalRuns.thresholds,
			reportFileId: evalRuns.reportFileId,
			reportName: files.declaredName,
			reportSize: files.sizeBytes,
			reportSha256: files.sha256,
			reportStatus: files.status
		})
		.from(evalRuns)
		.leftJoin(files, eq(files.id, evalRuns.reportFileId));
	const [row] = await (id === null ? query : query.where(eq(evalRuns.id, id)))
		.orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
		.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		createdAt: row.createdAt,
		productRevision: row.productRevision,
		datasetId: row.datasetId,
		datasetSize: row.datasetSize,
		datasetProvenance: row.datasetProvenance,
		split: row.split,
		processingMode: row.processingMode,
		versions: versionLines(row.versions),
		...evaluateRow(row.metrics, row.thresholds),
		report:
			row.reportFileId !== null && row.reportName !== null
				? {
						fileId: row.reportFileId,
						name: row.reportName,
						sizeBytes: row.reportSize ?? 0,
						sha256: row.reportSha256 ?? '',
						status: row.reportStatus ?? 'deleted'
					}
				: null
	};
}

/** The run to show — the latest one, or the one asked for — and the history of runs, newest first. */
export async function qualityPanel(
	executor: Executor,
	ctx: ActionContext,
	runId: string | null = null
): Promise<QualityPanel> {
	requirePermission(ctx.subject, 'policy.manage', null);
	const [run, history, [total]] = await Promise.all([
		runView(executor, runId),
		executor
			.select({ ...summaryColumns, metrics: evalRuns.metrics, thresholds: evalRuns.thresholds })
			.from(evalRuns)
			.orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
			.limit(HISTORY_SHOWN),
		executor.select({ n: count() }).from(evalRuns)
	]);
	return {
		run,
		history: history.map(({ metrics, thresholds, ...summary }) => {
			const { groups } = evaluateRow(metrics, thresholds);
			return {
				...summary,
				failed: groups === null ? null : groups.reduce((sum, group) => sum + group.failed, 0),
				metricCount: groups === null ? null : groups.reduce((sum, group) => sum + group.metrics.length, 0)
			};
		}),
		total: total?.n ?? 0
	};
}
