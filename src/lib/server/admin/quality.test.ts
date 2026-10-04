import { describe, expect, it } from 'vitest';
import { evaluateMetrics, runMetricsSchema, runThresholdsSchema } from './quality';

describe('evaluateMetrics', () => {
	it('checks each metric against its threshold and its baseline, groups in the order of the model', () => {
		const groups = evaluateMetrics(
			{
				'matching.ndcg_at_10': { value: 0.71, baseline: 0.52, n: 120 },
				'resume.f1': { value: 0.83 },
				'categorization.refusal_rate': { value: 0.31 },
				'custom.latency_p95': { value: null }
			},
			{
				'matching.ndcg_at_10': { min: 0.6 },
				'resume.f1': { min: 0.85 },
				'categorization.refusal_rate': { max: 0.25 }
			}
		);
		expect(groups.map((group) => group.key)).toEqual(['resume', 'categorization', 'matching', 'custom']);
		const rows = Object.fromEntries(groups.flatMap((group) => group.metrics).map((row) => [row.key, row]));
		expect(rows['matching.ndcg_at_10']).toMatchObject({ status: 'pass', n: 120 });
		expect(rows['matching.ndcg_at_10']?.delta).toBeCloseTo(0.19);
		expect(rows['resume.f1']).toMatchObject({ status: 'fail', baseline: null, delta: null });
		expect(rows['categorization.refusal_rate']).toMatchObject({ status: 'fail', threshold: { min: null, max: 0.25 } });
		expect(rows['custom.latency_p95']).toMatchObject({ status: 'no_value' });
		expect(groups.find((group) => group.key === 'resume')?.failed).toBe(1);
	});

	it('marks a metric without a threshold instead of judging it', () => {
		const [group] = evaluateMetrics({ 'skills.recall': { value: 0.9 } }, {});
		expect(group?.metrics[0]?.status).toBe('no_threshold');
	});
});

describe('run format', () => {
	it('refuses keys without a group and thresholds without a bound', () => {
		expect(runMetricsSchema.safeParse({ f1: { value: 0.5 } }).success).toBe(false);
		expect(runMetricsSchema.safeParse({ 'resume.f1': 0.5 }).success).toBe(false);
		expect(runThresholdsSchema.safeParse({ 'resume.f1': {} }).success).toBe(false);
		expect(runThresholdsSchema.safeParse({ 'resume.f1': { min: 0.8 } }).success).toBe(true);
	});
});
