// The files of `seeds/` (docs/domain.md, section 21): accounts of the roles, the companies and candidates of the demo
// scenario, the background companies, role profiles, the reference of regions and hero resumes (PDF and DOCX made by
// `scripts/demo-resumes.py`). Each file is validated on reading; a file that does not match stops the seed with its
// name. The content hash of every file is part of the batch id, so changed seed data is a new batch.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CATALOG_SCOPE_FIELDS } from '$lib/server/consent/kinds';
import { RegionReference, regionsFileSchema } from '$lib/server/regions';
import type { QuizSkill } from './quizzes';

/** Skills with a quiz in the bank (`assessments/quiz/`): a quiz a candidate of the demo takes is one of them. */
export const QUIZ_SKILLS = [
	'go',
	'python',
	'javascript',
	'typescript',
	'sql',
	'java',
	'kotlin',
	'csharp',
	'cpp',
	'php',
	'docker',
	'linux'
] as const satisfies readonly QuizSkill[];

const key = z.string().regex(/^[a-z0-9_]+$/);
const email = z.email().max(254);
const date = z.iso.date();

const salaryExpectation = z.strictObject({
	min: z.int().positive().nullable(),
	max: z.int().positive().nullable(),
	currency: z.literal('RUB'),
	period: z.literal('month'),
	tax_base: z.enum(['net', 'gross'])
});

const preferences = z.strictObject({
	work_formats: z.array(key),
	employment_forms: z.array(key),
	region_code: z.string().regex(/^RU-[A-Z]{2,3}$/),
	relocation: z.boolean(),
	salary_expectation: salaryExpectation.optional()
});

export type DemoPreferences = z.infer<typeof preferences>;

const competitionSelector = z.strictObject({
	discipline: z.enum(['algorithmic', 'product', 'uas', 'robotics', 'infosec']),
	level: z.string().min(1),
	stage: z.enum(['qualifier', 'final', 'single']),
	year: z.int().min(2024).max(2026)
});

const member = z.strictObject({
	key,
	role: z.enum(['owner', 'recruiter']),
	email,
	displayName: z.string().min(2).max(120)
});

const heroCandidate = z
	.strictObject({
		key,
		email,
		/** Key of a demo athlete of the simulator (`services/fsp-mock/src/seed/heroes.ts`); absent — no FSP history. */
		athlete: key.optional(),
		/** The name of a candidate without FSP; an athlete's name comes from the simulator. */
		name: z
			.strictObject({ lastName: z.string().min(1), firstName: z.string().min(1), middleName: z.string().min(1) })
			.optional(),
		birthDate: date,
		catalogScope: z.array(z.enum(CATALOG_SCOPE_FIELDS)),
		desiredRoles: z.array(key).max(3),
		preferences,
		resume: z
			.string()
			.regex(/^resumes\/[a-z0-9_]+\.(pdf|docx)$/)
			.optional(),
		github: z
			.string()
			.regex(/^[A-Za-z0-9-]{1,39}$/)
			.optional(),
		/** A platform quiz the hero took, with the ability the answers follow. */
		quiz: z.strictObject({ skill: z.enum(QUIZ_SKILLS), ability: z.number().min(-3).max(3) }).optional(),
		representative: z
			.strictObject({
				fullName: z.string().min(5),
				email,
				relation: z.enum(['parent', 'adoptive_parent', 'guardian', 'custodian'])
			})
			.optional()
	})
	.refine((c) => (c.athlete === undefined) !== (c.name === undefined), 'a hero has either an athlete or a name');

export type HeroCandidate = z.infer<typeof heroCandidate>;

const demoFile = z.strictObject({
	description: z.string(),
	version: z.int().positive(),
	staff: z.array(
		z.strictObject({
			key,
			role: z.enum(['operator', 'admin']),
			email,
			displayName: z.string().min(2).max(120)
		})
	),
	companies: z.array(
		z.strictObject({
			key,
			displayName: z.string().min(2),
			legalName: z.string().min(2),
			status: z.enum(['verified', 'submitted']),
			minorTerms: z.boolean(),
			partnership: z
				.strictObject({
					competition: competitionSelector,
					kind: z.enum(['case_provider', 'sponsor', 'organizer_partner']),
					basis: z.string().min(10)
				})
				.optional(),
			members: z.array(member).min(1)
		})
	),
	candidates: z.array(heroCandidate)
});

type DemoFile = z.infer<typeof demoFile>;

const companiesFile = z.strictObject({
	description: z.string(),
	companies: z.array(z.string().min(2)).min(1),
	organizations: z.array(z.string().min(2)).min(1)
});

const range = z.tuple([z.int().positive(), z.int().positive()]);

const rolesFile = z.strictObject({
	description: z.string(),
	grades: z.record(key, range),
	gradeTitles: z.record(key, z.string().min(1)),
	roles: z
		.array(
			z.strictObject({
				key,
				weight: z.number().positive(),
				multiplier: z.number().positive(),
				title: z.string().min(3),
				stacks: z
					.array(z.strictObject({ label: z.string().min(1), required: z.array(key).min(1), nice: z.array(key) }))
					.min(1)
			})
		)
		.min(1),
	disciplines: z.record(key, z.record(key, z.array(key).min(1)))
});

export type RoleProfile = z.infer<typeof rolesFile>['roles'][number];
type RolesFile = z.infer<typeof rolesFile>;

export interface SeedData {
	demo: DemoFile;
	companies: z.infer<typeof companiesFile>;
	roles: RolesFile;
	/** The reference of regions: the codes of the heroes and the regions of synthetic candidates by name. */
	regions: RegionReference;
	/** Resume files of the heroes by their path in `seeds/`. */
	resumes: Map<string, Uint8Array<ArrayBuffer>>;
	/** SHA-256 over every file read: changed seed data is a new batch. */
	sha256: string;
}

class SeedDataError extends Error {
	override name = 'SeedDataError';
}

/** `seeds/` of the working directory: the repository root in development, `/app` in the image. */
export function seedsDirectory(): string {
	return resolve(process.cwd(), 'seeds');
}

export async function readSeedData(directory: string): Promise<SeedData> {
	const hash = createHash('sha256');
	const read = async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
		const bytes = new Uint8Array(await readFile(join(directory, path)));
		hash.update(path).update('\0').update(bytes).update('\0');
		return bytes;
	};
	const parse = async <T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> => {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(await read(path));
		const parsed = schema.safeParse(JSON.parse(text));
		if (!parsed.success) throw new SeedDataError(`seeds/${path}: ${parsed.error.message}`);
		return parsed.data;
	};
	const demo = await parse('demo.json', demoFile);
	const companies = await parse('companies.json', companiesFile);
	const roles = await parse('roles.json', rolesFile);
	const regions = new RegionReference(await parse('regions.json', regionsFileSchema));
	for (const candidate of demo.candidates) {
		if (!regions.has(candidate.preferences.region_code)) {
			throw new SeedDataError(
				`seeds/demo.json: region ${candidate.preferences.region_code} of ${candidate.key} is not in seeds/regions.json`
			);
		}
	}
	const resumes = new Map<string, Uint8Array<ArrayBuffer>>();
	for (const candidate of demo.candidates) {
		if (candidate.resume !== undefined && !resumes.has(candidate.resume)) {
			resumes.set(candidate.resume, await read(candidate.resume));
		}
	}
	return { demo, companies, roles, regions, resumes, sha256: hash.digest('hex') };
}
