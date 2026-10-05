// The trajectory report of a release (docs/domain.md, 10.6): the model of answers of the procedure run over the
// families of a release, against `trajectoryAcceptance` through the contract's `trajectoryReportProblems`.
import { describe, expect, it } from 'vitest';
import { fixtureFamilies } from '../../../../tests/helpers/families';
import { CATALOG } from './contract/catalog';
import { PROCEDURE } from './contract/procedure';
import { trajectoryReportProblems } from './contract/validate';
import { labelRandom, runAttempt, simulatedScore, trajectoryReport } from './simulate';

const release = (specialization: 'backend' | 'qa') => ({
	id: `${specialization}@${CATALOG.version}-1`,
	specialization,
	catalogVersion: CATALOG.version,
	procedureVersion: PROCEDURE.version,
	families: [],
	sharedSha256: '0'.repeat(64),
	familySources: {}
});

describe('trajectory report', () => {
	it.each(['backend', 'qa'] as const)(
		'%s: every grade meets the trajectory acceptance, the curve grows with the true level',
		(specialization) => {
			const report = trajectoryReport(
				{ releaseId: release(specialization).id, seed: 'fixture' },
				fixtureFamilies(specialization),
				specialization
			);
			expect(trajectoryReportProblems(report, release(specialization), PROCEDURE)).toEqual([]);
			for (const grade of report.grades) {
				const confirmed = grade.points.map((p) => p.confirmed);
				expect(confirmed).toEqual([...confirmed].sort((a, b) => a - b));
			}
		},
		60_000
	);

	it('fails when the practice is rated at the borderline of its gate', () => {
		// A practice whose estimate sits at the gate is failed by a borderline-plus candidate too often.
		const report = trajectoryReport(
			{ releaseId: 'backend@x', seed: 'fixture' },
			fixtureFamilies('backend', { practiceAngoff: 0.45 }),
			'backend'
		);
		const problems = trajectoryReportProblems(
			{ ...report, releaseId: release('backend').id },
			release('backend'),
			PROCEDURE
		);
		expect(problems.some((p) => p.code === 'defect' && p.message.includes('true confirmation'))).toBe(true);
	}, 60_000);

	it('keeps the retake off the classes of the first attempt and is reproducible', () => {
		const families = fixtureFamilies('backend');
		const random = labelRandom('x');
		const score = (...[instance, family, angoff]: Parameters<Parameters<typeof runAttempt>[0]['score']>) =>
			simulatedScore(instance, family, angoff, 0, 0.5, random);
		const first = runAttempt({
			families,
			specialization: 'backend',
			grade: 'senior',
			form: 'A',
			seen: new Set(),
			attemptSeed: 'a1',
			score
		});
		const second = runAttempt({
			families,
			specialization: 'backend',
			grade: 'senior',
			form: 'B',
			seen: new Set(first.served),
			attemptSeed: 'a2',
			score
		});
		expect(second.served.filter((key) => first.served.includes(key))).toEqual([]);
		const small = () => trajectoryReport({ releaseId: 'r', seed: 'r' }, families, 'backend', { runs: 30 });
		expect(small()).toEqual(small());
	}, 60_000);
});
