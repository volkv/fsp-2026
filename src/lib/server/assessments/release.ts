// Assembling a bank release (docs/domain.md, 10.5): the families of one specialization with their versions, the hash of
// the content and of the shared code, the admission report of every family, the capacity report of every extreme
// history, the anchors and the trajectory report of the engine. A release is admitted only without problems: the
// contract's `releaseProblems` (gates, anchors, block tests, capacity, trajectories) and what this engine needs to serve
// a family — a generator that returns valid instances for every class, a harness for QA, a rubric it can score. Pure
// functions over loaded families; the release script and the tests call them.
//
// Plain erasable TypeScript without `$lib`.
import { canonicalJson } from '../json/canonical.ts';
import {
	capacityChecks,
	judgementProvenance,
	type BankRelease,
	type CapacityCheck,
	type FamilyDescriptor
} from './contract/bank.ts';
import { CATALOG, GRADE_KEYS, type GradeKey, type SpecializationKey } from './contract/catalog.ts';
import { PROCEDURE, type ProcedureParams } from './contract/procedure.ts';
import {
	familyProblems,
	instanceProblems,
	levelsByBlock,
	releaseProblems,
	type TrajectoryReport
} from './contract/validate.ts';
import { sha256Hex, type LoadedFamily } from './families.ts';
import { trajectoryReport } from './simulate.ts';
import { parseStatement } from './statement.ts';

/** A family as the release records it: the descriptor and the hash of the generator that serves it. */
export interface ManifestFamily {
	descriptor: FamilyDescriptor;
	generatorSha256: string;
}

/** How the family-levels of a grade were judged (domain 10.8): by models only, or signed by a person. */
export interface GradeJudgement {
	levels: number;
	/** Family-levels whose rubric was approved by models only. */
	rubricByModelsOnly: number;
	/** Family-levels whose Angoff cut rests on model ratings only. */
	angoffProvisional: number;
}

export interface ReleaseManifest {
	families: ManifestFamily[];
	/** `familySourceSha256` of every family by key: reviews and ratings count only on these sources. */
	familySources: Record<string, string>;
	/** `judgementProvenance` of the family-levels, by grade. */
	judgement: Record<GradeKey, GradeJudgement>;
	/** Admission problems of every family (empty lists in an admitted release). */
	gates: Record<string, string[]>;
	capacityChecks: CapacityCheck[];
	/** Family-levels with an anchor class, by grade. */
	anchors: Record<GradeKey, string[]>;
	/** Family-levels per block, by grade, against the quotas of the catalog. */
	levelsByBlock: Record<GradeKey, Record<string, number>>;
	/** The engine's simulation of whole trajectories on these families (domain 10.6); `null` — a generator is broken. */
	trajectories: TrajectoryReport | null;
}

export interface AssembledRelease {
	release: BankRelease;
	manifest: ReleaseManifest;
	contentSha256: string;
	problems: string[];
}

/** Seed of the sample instances the release builds of every class to check the generator. */
const SAMPLE_SEEDS = ['release-sample-1', 'release-sample-2'];

/**
 * The hash of a release's content: the canonical JSON of the descriptors, the hashes of their generators and the hash of
 * the shared code — a change of any of them is a new release.
 */
export function releaseContentSha256(families: readonly ManifestFamily[], sharedSha256: string): string {
	const sorted = [...families].sort((a, b) => (a.descriptor.key < b.descriptor.key ? -1 : 1));
	return sha256Hex(
		canonicalJson({
			families: sorted.map((f) => ({ descriptor: f.descriptor, generator: f.generatorSha256 })),
			shared: sharedSha256
		})
	);
}

export const releaseId = (specialization: SpecializationKey, n: number): string =>
	`${specialization}@${CATALOG.version}-${n}`;

/** What the engine needs beyond the contract: generators that produce valid instances, a QA harness, a scorable rubric. */
export function servingProblems(family: LoadedFamily): string[] {
	const { descriptor, module } = family;
	const where = `family ${descriptor.key}`;
	const problems: string[] = [];
	if (descriptor.rubric.kind === 'parts') {
		problems.push(`${where}: a rubric of parts needs an answer per part, which an instance does not carry`);
	}
	if (descriptor.format === 'qa_mutation' && !module.harness) problems.push(`${where}: QA needs harness()`);
	for (const level of descriptor.levels) {
		for (const cls of level.classes) {
			for (const seed of SAMPLE_SEEDS) {
				let instance;
				try {
					instance = module.generate({ seed, grade: level.grade, classId: cls.id });
				} catch (error) {
					problems.push(`${where}@${level.grade}/${cls.id}: generate failed: ${(error as Error).message}`);
					continue;
				}
				problems.push(...instanceProblems(instance, descriptor));
				if (instance.seed !== seed || instance.classId !== cls.id || instance.grade !== level.grade) {
					problems.push(`${where}@${level.grade}/${cls.id}: the instance does not echo its seed, grade and class`);
				}
				const again = module.generate({ seed, grade: level.grade, classId: cls.id });
				if (canonicalJson(again) !== canonicalJson(instance)) {
					problems.push(`${where}@${level.grade}/${cls.id}: generate is not deterministic`);
				}
				for (const markdown of [instance.statement.markdown, instance.changeStep?.markdown ?? '']) {
					try {
						parseStatement(markdown);
					} catch (error) {
						problems.push(`${where}@${level.grade}/${cls.id}: statement: ${(error as Error).message}`);
					}
				}
				if (descriptor.format === 'qa_mutation' && module.harness) {
					for (const part of instance.changeStep?.qa ? (['task', 'change_step'] as const) : (['task'] as const)) {
						for (const mode of ['reference', 'mutants'] as const) {
							if (module.harness(instance, mode, part).source.trim() === '') {
								problems.push(`${where}@${level.grade}/${cls.id}: the ${part} harness of ${mode} is empty`);
							}
						}
					}
				}
			}
		}
	}
	return problems;
}

/** The release of a specialization from its loaded families, numbered `n`, with every problem that keeps it out. */
export function assembleRelease(
	specialization: SpecializationKey,
	families: readonly LoadedFamily[],
	sharedSha256: string,
	n: number,
	options: { params?: ProcedureParams; runs?: number } = {}
): AssembledRelease {
	const params = options.params ?? PROCEDURE;
	const release: BankRelease = {
		id: releaseId(specialization, n),
		specialization,
		catalogVersion: CATALOG.version,
		procedureVersion: params.version,
		families: families.map((f) => f.descriptor),
		sharedSha256,
		familySources: Object.fromEntries(families.map((f) => [f.descriptor.key, f.sourceSha256]))
	};
	const gates: Record<string, string[]> = {};
	const serving: string[] = [];
	for (const family of families) {
		const problems = servingProblems(family);
		gates[family.descriptor.key] = [...familyProblems(family.descriptor, family.sourceSha256), ...problems];
		serving.push(...problems);
	}
	const trajectories =
		serving.length === 0
			? trajectoryReport(release.id, families, specialization, {
					params,
					...(options.runs === undefined ? {} : { runs: options.runs })
				})
			: null;
	const problems = [...serving];
	if (trajectories) problems.push(...releaseProblems(release, params, trajectories));
	const anchors = {} as Record<GradeKey, string[]>;
	const byBlock = {} as Record<GradeKey, Record<string, number>>;
	const judgement = {} as Record<GradeKey, GradeJudgement>;
	for (const grade of GRADE_KEYS) {
		const judged = release.families
			.filter((f) => f.levels.some((l) => l.grade === grade))
			.map((f) => judgementProvenance(f, grade));
		judgement[grade] = {
			levels: judged.length,
			rubricByModelsOnly: judged.filter((j) => j.rubricByModelsOnly).length,
			angoffProvisional: judged.filter((j) => j.angoffProvisional).length
		};
		anchors[grade] = release.families
			.filter((f) => f.levels.some((l) => l.grade === grade && l.classes.some((c) => c.form === 'anchor')))
			.map((f) => f.key);
		byBlock[grade] = Object.fromEntries(levelsByBlock(release, grade));
	}
	const manifestFamilies = families.map((f) => ({ descriptor: f.descriptor, generatorSha256: f.generatorSha256 }));
	return {
		release,
		manifest: {
			families: manifestFamilies,
			familySources: { ...release.familySources },
			judgement,
			gates,
			capacityChecks: capacityChecks(release, params),
			anchors,
			levelsByBlock: byBlock,
			trajectories
		},
		contentSha256: releaseContentSha256(manifestFamilies, sharedSha256),
		problems
	};
}
