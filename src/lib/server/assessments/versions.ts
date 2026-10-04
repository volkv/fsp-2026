// Reading assessment versions back: the jsonb columns are parsed with the schemas of the bank, so a service never
// judges by a shape the bank did not declare.
import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { assessments, assessmentVersions } from '$lib/server/db/schema';
import {
	codeItemBankSchema,
	codeScorerSchema,
	coverageSchema,
	levelScaleSchema,
	quizItemBankSchema,
	quizScorerSchema,
	type Coverage,
	type LevelScale
} from './bank';
import type { z } from 'zod';

interface VersionHeader {
	id: string;
	assessmentId: string;
	version: number;
	status: 'draft' | 'published' | 'retired' | 'defective';
	title: string;
	skillKeys: string[];
	coverage: Coverage;
	contentSha256: string;
	createdAt: Date;
}

export type CodeVersion = VersionHeader & {
	kind: 'code_task';
	scorer: z.infer<typeof codeScorerSchema>;
	levelScale: Extract<LevelScale, { type: 'tests_passed' }>;
	itemBank: z.infer<typeof codeItemBankSchema>;
};

export type QuizVersion = VersionHeader & {
	kind: 'quiz';
	scorer: z.infer<typeof quizScorerSchema>;
	levelScale: Extract<LevelScale, { type: 'ability' }>;
	itemBank: z.infer<typeof quizItemBankSchema>;
};

export type LoadedVersion = CodeVersion | QuizVersion;

const columns = {
	id: assessmentVersions.id,
	assessmentId: assessmentVersions.assessmentId,
	version: assessmentVersions.version,
	status: assessmentVersions.status,
	contentSha256: assessmentVersions.contentSha256,
	scorer: assessmentVersions.scorer,
	levelScale: assessmentVersions.levelScale,
	coverage: assessmentVersions.coverage,
	itemBank: assessmentVersions.itemBank,
	createdAt: assessmentVersions.createdAt,
	kind: assessments.kind,
	title: assessments.title,
	skillKeys: assessments.skillKeys
};

type Row = { [K in keyof typeof columns]: (typeof columns)[K]['_']['data'] };

function parseVersion(row: Row): LoadedVersion {
	const header = {
		id: row.id,
		assessmentId: row.assessmentId,
		version: row.version,
		status: row.status,
		title: row.title,
		skillKeys: row.skillKeys,
		coverage: coverageSchema.parse(row.coverage),
		contentSha256: row.contentSha256,
		createdAt: row.createdAt
	};
	const levelScale = levelScaleSchema.parse(row.levelScale);
	switch (row.kind) {
		case 'code_task':
			if (levelScale.type !== 'tests_passed')
				throw new Error(`version ${row.id}: a code task needs a tests_passed scale`);
			return {
				...header,
				kind: 'code_task',
				scorer: codeScorerSchema.parse(row.scorer),
				levelScale,
				itemBank: codeItemBankSchema.parse(row.itemBank)
			};
		case 'quiz':
			if (levelScale.type !== 'ability') throw new Error(`version ${row.id}: a quiz needs an ability scale`);
			return {
				...header,
				kind: 'quiz',
				scorer: quizScorerSchema.parse(row.scorer),
				levelScale,
				itemBank: quizItemBankSchema.parse(row.itemBank)
			};
		case 'open_answer':
			throw new Error(`version ${row.id}: open answers are not scored by this platform`);
	}
}

export async function loadVersion(executor: Executor, versionId: string): Promise<LoadedVersion | null> {
	const [row] = await executor
		.select(columns)
		.from(assessmentVersions)
		.innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
		.where(eq(assessmentVersions.id, versionId));
	return row ? parseVersion(row) : null;
}

export async function loadVersions(executor: Executor, versionIds: string[]): Promise<Map<string, LoadedVersion>> {
	if (versionIds.length === 0) return new Map();
	const rows = await executor
		.select(columns)
		.from(assessmentVersions)
		.innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
		.where(inArray(assessmentVersions.id, [...new Set(versionIds)]));
	return new Map(rows.map((row) => [row.id, parseVersion(row)]));
}

/** Published versions: one per assessment the catalog offers. */
export async function publishedVersions(executor: Executor, assessmentId?: string): Promise<LoadedVersion[]> {
	const rows = await executor
		.select(columns)
		.from(assessmentVersions)
		.innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
		.where(
			and(
				eq(assessmentVersions.status, 'published'),
				assessmentId === undefined ? undefined : eq(assessmentVersions.assessmentId, assessmentId)
			)
		);
	return rows.map(parseVersion);
}
