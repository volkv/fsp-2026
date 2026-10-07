// The files of `seeds/` (docs/domain.md, sections 21, 23.3): accounts of the roles, the companies and candidates of the
// demo scenario with the path each hero has taken — the survey, the declared grade, the tests and their decisions, the
// needs, shortlists and offers of the scenario companies — the background companies, role profiles, the reference of
// regions and hero resumes (PDF and DOCX made by `scripts/demo-resumes.py`). Each file is validated on reading; a file
// that does not match stops the seed with its name. The content hash of every file is part of the batch id, so changed
// seed data is a new batch.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { CATALOG_SCOPE_FIELDS, DISCLOSURE_FIELDS } from '$lib/server/consent/kinds';
import { MESSAGE_SIDES, MESSAGE_TEXT_MAX } from '$lib/server/db/schema';
import { needFormSchema } from '$lib/server/needs/form';
import { CONTACT_KINDS, OFFER_WORK_FORMATS } from '$lib/server/invitations/terms';
import { isSoftSkillKey } from '$lib/server/profile/soft-skills';
import { RegionReference, regionsFileSchema } from '$lib/server/regions';

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

/**
 * How a test of the hero ended (domain 10.6): `confident` — confirmed with the margin that opens the next grade at once,
 * `confirmed` — confirmed without it, `not_confirmed`, `undetermined`.
 */
export const TEST_OUTCOMES = ['confident', 'confirmed', 'not_confirmed', 'undetermined'] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

/**
 * The hero's path through the test (domain 12.2, 12.3): the survey of a specialization, the declared grade and the
 * attempts in their order, each with the outcome the scenario shows. The grade policy decides whether each attempt may
 * start; an attempt it refuses stops the seed.
 */
const heroAssessment = z.strictObject({
	specialization: z.enum(SPECIALIZATION_KEYS),
	/** The declared stack of the survey: skills of the taxonomy. */
	skills: z.array(key).min(1).max(10),
	declared: z.enum(GRADE_KEYS),
	attempts: z.array(z.strictObject({ grade: z.enum(GRADE_KEYS), outcome: z.enum(TEST_OUTCOMES) })).max(3)
});

export type HeroAssessment = z.infer<typeof heroAssessment>;

/** Fields the hero typed in the profile by hand (domain 7.1). */
const heroProfile = z.strictObject({
	headline: z.string().min(3).max(200),
	softSkills: z.array(z.string().refine(isSoftSkillKey, 'not a soft skill of the reference')).max(5)
});

const heroCandidate = z
	.strictObject({
		key,
		email,
		/** What the hero is in the scenario: shown beside the name on the screen of demo roles. */
		part: z.string().min(10).max(200),
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
		representative: z
			.strictObject({
				fullName: z.string().min(5),
				email,
				relation: z.enum(['parent', 'adoptive_parent', 'guardian', 'custodian'])
			})
			.optional(),
		/** Absent for a minor: the fields wait for the representative's consent to processing (domain 7.3). */
		profile: heroProfile.optional(),
		/** Absent — the hero has not taken the survey: the specialization has no released test or the scenario waits. */
		assessment: heroAssessment.optional()
	})
	.refine((c) => (c.athlete === undefined) !== (c.name === undefined), 'a hero has either an athlete or a name');

export type HeroCandidate = z.infer<typeof heroCandidate>;

/** A hiring need of a scenario company (domain 13.10): the text «Опишите, кого ищете» and the form the employer confirmed. */
const scenarioNeed = z.strictObject({
	key,
	text: z.string().min(20).max(5000),
	form: needFormSchema,
	/** Heroes the company marked in the shortlist of the need, with the note of the mark. */
	marks: z.array(z.strictObject({ candidate: key, note: z.string().max(500).nullable() }))
});

/** An offer of a scenario company to a hero (domain 13.5) and how far it went. */
const scenarioOffer = z.strictObject({
	candidate: key,
	/** The need it is sent from: «why you» comes from the shortlist of that need. */
	need: key.optional(),
	title: z.string().min(3).max(120),
	description: z.string().min(50).max(5000),
	salary: z.strictObject({ min: z.int().positive(), max: z.int().positive(), taxBase: z.enum(['net', 'gross']) }),
	workFormat: z.enum(OFFER_WORK_FORMATS),
	contact: z.strictObject({ kind: z.enum(CONTACT_KINDS), value: z.string().min(1).max(200) }),
	message: z.string().max(2000).nullable(),
	state: z.enum(['sent', 'viewed', 'accepted', 'declined']),
	/** Fields the hero discloses on acceptance. */
	disclose: z.array(z.enum(DISCLOSURE_FIELDS)).optional(),
	/** Stages of hiring the company reported after the acceptance, in order. */
	stages: z.array(z.enum(['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'])).optional(),
	/** The conversation after the acceptance (domain 13.15), in order: the company's side writes as its sender. */
	messages: z
		.array(z.strictObject({ from: z.enum(MESSAGE_SIDES), text: z.string().min(1).max(MESSAGE_TEXT_MAX) }))
		.max(10)
		.optional()
});

export type ScenarioOffer = z.infer<typeof scenarioOffer>;
export type ScenarioNeed = z.infer<typeof scenarioNeed>;

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
			members: z.array(member).min(1),
			needs: z.array(scenarioNeed).optional(),
			offers: z.array(scenarioOffer).optional()
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
	const heroes = new Set(demo.candidates.map((candidate) => candidate.key));
	for (const company of demo.companies) {
		const needs = new Set((company.needs ?? []).map((need) => need.key));
		const named = [
			...(company.needs ?? []).flatMap((need) => need.marks.map((mark) => mark.candidate)),
			...(company.offers ?? []).map((offer) => offer.candidate)
		];
		for (const hero of named) {
			if (!heroes.has(hero)) throw new SeedDataError(`seeds/demo.json: ${company.key} names an unknown hero ${hero}`);
		}
		for (const offer of company.offers ?? []) {
			if (offer.need !== undefined && !needs.has(offer.need)) {
				throw new SeedDataError(`seeds/demo.json: an offer of ${company.key} names an unknown need ${offer.need}`);
			}
			// A conversation opens with the acceptance only.
			if (offer.messages !== undefined && offer.state !== 'accepted') {
				throw new SeedDataError(`seeds/demo.json: an offer of ${company.key} has messages but is not accepted`);
			}
		}
	}
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
