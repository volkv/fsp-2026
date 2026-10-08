// Deterministic plans of the demo data: who the candidates are, which companies exist and what they publish.
// Everything here is computed from the seed data, the simulator's dataset and the
// batch id with seeded random numbers, so the same inputs give the same plans; nothing touches the database.
import { createHash } from 'node:crypto';
import { Random } from '../../../../services/fsp-mock/src/seed/random.ts';
import { syntheticName, syntheticRegion, translit } from '../../../../services/fsp-mock/src/seed/names.ts';
import { GRADE_KEYS, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { specializationsOfRole } from '$lib/server/categories/roles';
import type { CatalogScopeField } from '$lib/server/consent/kinds';
import type { NeedForm } from '$lib/server/needs/form';
import type { ExperienceInput } from '$lib/server/profile/experience';
import { SOFT_SKILLS } from '$lib/server/profile/soft-skills';
import {
	type DemoPreferences,
	type HeroAssessment,
	type HeroCandidate,
	type RoleProfile,
	type SeedData,
	type TestOutcome
} from './data';
import type { GradeReach, OutcomeReach } from './foresight';
import type { WorldAthlete } from './world';

export { Random };

interface PersonName {
	lastName: string;
	firstName: string;
	middleName: string | null;
}

/** One test of the plan: the grade and the outcome the seeded verdict is to give (domain 23.3). */
export interface AttemptPlan {
	grade: GradeKey;
	outcome: TestOutcome;
}

/**
 * The candidate's path through the test: the survey of the specialization with the declared stack, the declared grade
 * and the attempts in their order. The seed takes it only when the specialization has a released bank; otherwise the
 * candidate stays without a survey and the report of the seed counts them.
 */
export interface AssessmentPlan {
	specialization: SpecializationKey;
	skills: string[];
	declared: GradeKey;
	attempts: AttemptPlan[];
}

/** What the candidate typed in the profile by hand (domain 7.1). */
export interface ProfilePlan {
	headline: string;
	softSkills: string[];
	experience: ExperienceInput[];
}

export interface CandidatePlan {
	/** Stable key: the hero key, `fsp:<athlete>` or `resume:<n>`. */
	key: string;
	email: string;
	name: PersonName;
	birthDate: string;
	athlete: WorldAthlete | null;
	/** Blocks of the catalog card; `null` — the candidate does not show the profile in the catalog. */
	catalogScope: CatalogScopeField[] | null;
	desiredRoles: string[];
	preferences: DemoPreferences | { work_formats: string[]; employment_forms: string[]; relocation: boolean };
	searchStatus: 'active' | 'open_to_offers';
	/** The file the candidate uploads: a hero's PDF or DOCX from `seeds/resumes/`, a background candidate's text. */
	resume: { declaredName: string; bytes: Uint8Array<ArrayBuffer> } | null;
	github: string | null;
	/** `null` — a minor: the fields wait for the representative's consent to processing (domain 7.3). */
	profile: ProfilePlan | null;
	/** The tests of each specialization, in the order taken; empty — the candidate has not taken the survey. */
	assessments: AssessmentPlan[];
}

const DAY = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');
const round5k = (value: number) => Math.max(5_000, Math.round(value / 5_000) * 5_000);

/** Grade by age for a candidate's expectations and a synthetic resume. */
function gradeOfAge(age: number, rnd: Random): string {
	if (age <= 20) return rnd.chance(0.6) ? 'intern' : 'junior';
	if (age <= 23) return rnd.chance(0.7) ? 'junior' : 'middle';
	if (age <= 27) return rnd.chance(0.7) ? 'middle' : rnd.pick(['junior', 'senior']);
	if (age <= 34) return rnd.chance(0.65) ? 'senior' : 'middle';
	return rnd.chance(0.3) ? 'lead' : 'senior';
}

function roleByKey(data: SeedData, key: string): RoleProfile {
	const role = data.roles.roles.find((r) => r.key === key);
	if (!role) throw new Error(`seeds/roles.json has no role ${key}`);
	return role;
}

function band(data: SeedData, grade: string, multiplier: number): [number, number] {
	const range = data.roles.grades[grade];
	if (!range) throw new Error(`seeds/roles.json has no salary range of grade ${grade}`);
	return [range[0] * multiplier, range[1] * multiplier];
}

function expectation(data: SeedData, rnd: Random, roleKey: string, grade: string) {
	const [low, high] = band(data, grade, roleByKey(data, roleKey).multiplier);
	const min = round5k(low + (high - low) * rnd.next() * 0.8);
	return {
		min,
		max: rnd.chance(0.5) ? round5k(min * (1.1 + rnd.next() * 0.2)) : null,
		currency: 'RUB' as const,
		period: 'month' as const,
		tax_base: rnd.chance(0.85) ? ('net' as const) : ('gross' as const)
	};
}

function workTerms(rnd: Random, young: boolean) {
	const formats = rnd.weighted<string[]>([
		[['remote'], 3],
		[['hybrid', 'remote'], 3],
		[['office', 'hybrid'], 2],
		[['office'], 1]
	]);
	return {
		work_formats: formats,
		employment_forms: young && rnd.chance(0.5) ? ['full', 'internship'] : ['full'],
		relocation: rnd.chance(0.25)
	};
}

const birthDateOf = (rnd: Random, year: number) => `${year}-${pad(rnd.int(1, 12))}-${pad(rnd.int(1, 28))}`;

/** The specialization of the catalog the first tested role of the candidate names; `null` — no role is tested. */
function specializationOf(roles: readonly string[]): SpecializationKey | null {
	for (const role of roles) {
		const [first] = specializationsOfRole(role);
		if (first !== undefined) return first;
	}
	return null;
}

/** The grade of the catalog a grade of the salary bands stands for: the catalog ends with Senior. */
function catalogGrade(grade: string): GradeKey {
	if (grade === 'lead') return 'senior';
	const known = GRADE_KEYS.find((key) => key === grade);
	if (known === undefined) throw new Error(`grade ${grade} is not in the catalog`);
	return known;
}

/**
 * The attempts of a background candidate after the survey (domain 12.3): none yet, one at the declared grade with each
 * outcome, a failure followed by the test below it, or a confident result followed by the next grade at once. Only the
 * paths whose every outcome the released bank gives at its grade (`reach`); a specialization without a released bank
 * (`undefined`) is not tested, and its paths are counted as closed.
 */
function attemptsOf(rnd: Random, declared: GradeKey, reach: GradeReach | undefined): AttemptPlan[] {
	const index = GRADE_KEYS.indexOf(declared);
	const below = index > 0 ? GRADE_KEYS[index - 1] : undefined;
	const above = GRADE_KEYS[index + 1];
	const at = (outcome: TestOutcome): AttemptPlan => ({ grade: declared, outcome });
	const paths: [AttemptPlan[], number][] = [
		[[], 14],
		[[at('confident')], 20],
		[[at('confirmed')], 24],
		[[at('not_confirmed')], 12],
		[[at('undetermined')], 5]
	];
	if (below !== undefined) {
		paths.push([[at('not_confirmed'), { grade: below, outcome: rnd.chance(0.3) ? 'confident' : 'confirmed' }], 10]);
	}
	if (above !== undefined) {
		paths.push([[at('confident'), { grade: above, outcome: rnd.chance(0.5) ? 'confirmed' : 'not_confirmed' }], 6]);
	}
	const given = (attempt: AttemptPlan) =>
		reach === undefined || reach.get(attempt.grade)?.has(attempt.outcome) === true;
	return rnd.weighted(paths.filter(([attempts]) => attempts.every(given)));
}

/** The survey and the tests of a background candidate of `roles`; `null` — no role of theirs is tested. */
function assessmentOf(
	data: SeedData,
	rnd: Random,
	roles: readonly string[],
	grade: string,
	stack: RoleProfile['stacks'][number] | null,
	reach: OutcomeReach
): AssessmentPlan | null {
	const specialization = specializationOf(roles);
	if (specialization === null) return null;
	const role = roles.find((key) => specializationsOfRole(key).includes(specialization));
	const own = stack ?? (role === undefined ? null : rnd.pick(roleByKey(data, role).stacks));
	if (own === null) return null;
	const skills = [...own.required, ...own.nice.filter(() => rnd.chance(0.6))].slice(0, 10);
	const declared = catalogGrade(grade);
	return { specialization, skills, declared, attempts: attemptsOf(rnd, declared, reach.get(specialization)) };
}

function softSkillsOf(rnd: Random): string[] {
	return rnd.shuffle(SOFT_SKILLS.map((skill) => skill.key)).slice(0, rnd.int(0, 3));
}

const monthOf = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;

/** A place of work typed by hand: the current job of an athlete without a resume. */
function manualExperience(data: SeedData, rnd: Random, role: RoleProfile, grade: string, now: Date): ExperienceInput {
	const stack = rnd.pick(role.stacks);
	const months = grade === 'intern' ? rnd.int(3, 8) : grade === 'junior' ? rnd.int(8, 24) : rnd.int(18, 60);
	return {
		position_title: `${stack.label}-разработчик`,
		organization_name: rnd.pick(data.companies.organizations),
		role_key: role.key,
		period_from: monthOf(new Date(now.getTime() - months * 30 * DAY)),
		period_to: null,
		skill_keys: [...stack.required],
		description: 'Разработка и поддержка продуктовых сервисов команды.'
	};
}

const headlineOf = (data: SeedData, grade: string, role: RoleProfile) =>
	`${data.roles.gradeTitles[grade] ?? ''} ${role.title}`.trim();

/** A hero's resume file under the name a person gives it: «Резюме Фамилия Имя.pdf». */
function heroResume(path: string, name: PersonName, data: SeedData): NonNullable<CandidatePlan['resume']> {
	const bytes = data.resumes.get(path);
	if (bytes === undefined) throw new Error(`seeds/${path} was not read with the seed data`);
	return { declaredName: `Резюме ${name.lastName} ${name.firstName}${path.slice(path.lastIndexOf('.'))}`, bytes };
}

/** A candidate of the scenario: named in `seeds/demo.json`; an athlete's name and age come from the simulator. */
export function heroPlan(hero: HeroCandidate, athlete: WorldAthlete | null, data: SeedData): CandidatePlan {
	const name: PersonName = athlete
		? { lastName: athlete.lastName, firstName: athlete.firstName, middleName: athlete.middleName }
		: {
				lastName: hero.name?.lastName ?? '',
				firstName: hero.name?.firstName ?? '',
				middleName: hero.name?.middleName ?? null
			};
	if (athlete && Number(hero.birthDate.slice(0, 4)) !== athlete.birthYear) {
		throw new Error(`seeds/demo.json: ${hero.key} is born in ${hero.birthDate}, the athlete in ${athlete.birthYear}`);
	}
	return {
		key: hero.key,
		email: hero.email,
		name,
		birthDate: hero.birthDate,
		athlete,
		// A minor shows the profile only after a representative's authority is verified (domain 7.3).
		catalogScope: hero.representative ? null : hero.catalogScope,
		desiredRoles: hero.desiredRoles,
		preferences: hero.preferences,
		searchStatus: 'active',
		resume: hero.resume === undefined ? null : heroResume(hero.resume, name, data),
		github: hero.github ?? null,
		profile:
			hero.profile === undefined
				? null
				: { headline: hero.profile.headline, softSkills: hero.profile.softSkills, experience: [] },
		assessments: hero.assessments.map(heroAssessment)
	};
}

const listOf = <T>(value: T | null): T[] => (value === null ? [] : [value]);

function heroAssessment(plan: HeroAssessment): AssessmentPlan {
	return {
		specialization: plan.specialization,
		skills: plan.skills,
		declared: plan.declared,
		attempts: plan.attempts.map((attempt) => ({ grade: attempt.grade, outcome: attempt.outcome }))
	};
}

/**
 * The code of a region the simulator names. A name the reference does not know stops the seed: a candidate would
 * otherwise lose the region without a trace.
 */
function regionCodeOf(data: SeedData, name: string, owner: string): string {
	const code = data.regions.codeOf(name);
	if (code === undefined) throw new Error(`region «${name}» of ${owner} is not in seeds/regions.json`);
	return code;
}

/** A synthetic candidate linked to an athlete of the simulator. */
export function athletePlan(
	athlete: WorldAthlete,
	data: SeedData,
	batch: string,
	now: Date,
	reach: OutcomeReach
): CandidatePlan {
	const rnd = new Random(`${batch}:athlete:${athlete.fspId}`);
	const age = now.getUTCFullYear() - athlete.birthYear;
	const byDiscipline = data.roles.disciplines[athlete.discipline] ?? data.roles.disciplines.algorithmic;
	const roles = (athlete.specialization ? byDiscipline?.[athlete.specialization] : undefined) ??
		byDiscipline?.default ?? ['backend'];
	const desiredRoles = roles.slice(0, rnd.chance(0.6) ? 1 : 2);
	// Most athletes whose first role no test checks also want a tested one of their discipline (an olympiad programmer —
	// backend too): they take its test.
	const tested = roles.find((role) => specializationsOfRole(role).length > 0);
	if (specializationOf(desiredRoles) === null && tested !== undefined && rnd.chance(0.8)) desiredRoles.push(tested);
	const primaryRole = desiredRoles[0] ?? 'backend';
	const grade = gradeOfAge(age, rnd);
	// A blank region is not stated; a stated one must be in the reference.
	const region =
		athlete.region === null || athlete.region.trim() === ''
			? undefined
			: regionCodeOf(data, athlete.region, `athlete ${athlete.fspId}`);
	const terms = workTerms(rnd, age <= 22);
	const visible = rnd.chance(0.93);
	return {
		key: `fsp:${athlete.fspId}`,
		email: athlete.email,
		name: { lastName: athlete.lastName, firstName: athlete.firstName, middleName: athlete.middleName },
		birthDate: birthDateOf(rnd, athlete.birthYear),
		athlete,
		catalogScope: visible ? (rnd.chance(0.55) ? ['fsp_achievements_exact'] : []) : null,
		desiredRoles,
		preferences: {
			...terms,
			...(region === undefined ? {} : { region_code: region }),
			...(rnd.chance(0.8) ? { salary_expectation: expectation(data, rnd, primaryRole, grade) } : {})
		},
		searchStatus: rnd.chance(0.75) ? 'active' : 'open_to_offers',
		resume: null,
		github: null,
		profile: {
			headline: headlineOf(data, grade, roleByKey(data, primaryRole)),
			softSkills: softSkillsOf(rnd),
			experience:
				age >= 20 && rnd.chance(0.45) ? [manualExperience(data, rnd, roleByKey(data, primaryRole), grade, now)] : []
		},
		assessments: listOf(assessmentOf(data, rnd, desiredRoles, grade, null, reach))
	};
}

const MONTHS = [
	'Январь',
	'Февраль',
	'Март',
	'Апрель',
	'Май',
	'Июнь',
	'Июль',
	'Август',
	'Сентябрь',
	'Октябрь',
	'Ноябрь',
	'Декабрь'
];

const UNIVERSITIES = [
	'Московский государственный университет им. М. В. Ломоносова',
	'Университет ИТМО',
	'Новосибирский государственный университет',
	'Уральский федеральный университет',
	'Томский политехнический университет',
	'Казанский федеральный университет',
	'Нижегородский государственный университет им. Н. И. Лобачевского',
	'Самарский университет'
];

function pickRole(data: SeedData, rnd: Random): RoleProfile {
	return rnd.weighted(data.roles.roles.map((role) => [role, role.weight] as const));
}

/** Text of a synthetic resume in the layout the rules extractor reads: headed sections and dated jobs. */
function resumeText(
	data: SeedData,
	rnd: Random,
	input: {
		name: PersonName;
		role: RoleProfile;
		stack: RoleProfile['stacks'][number];
		grade: string;
		age: number;
		now: Date;
		skillNames: ReadonlyMap<string, string>;
	}
): string {
	const { stack } = input;
	const skills = [...stack.required, ...stack.nice.filter(() => rnd.chance(0.6))];
	const nameOf = (key: string) => input.skillNames.get(key) ?? key;
	const years = Math.max(1, Math.min(input.age - 21, input.grade === 'junior' ? 2 : input.grade === 'middle' ? 4 : 9));
	const jobs: string[] = [];
	let end: Date | null = null;
	let remaining = years * 12;
	for (let i = 0; i < 3 && remaining > 0; i++) {
		const months = i === 2 ? remaining : Math.min(remaining, rnd.int(14, 40));
		const to: Date = end ?? input.now;
		const from: Date = new Date(to.getTime() - months * 30 * DAY);
		const period = `${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()} — ${
			end === null ? 'настоящее время' : `${MONTHS[to.getUTCMonth()]?.toLowerCase()} ${to.getUTCFullYear()}`
		}`;
		const organization = rnd.pick(data.companies.organizations);
		const title = i === 0 ? `${stack.label}-разработчик` : 'Разработчик';
		const used = skills.slice(0, 3).map(nameOf).join(', ');
		jobs.push(
			`${period}\n\n${organization.includes('«') ? organization : `ООО «${organization}»`}\n\n${title}\n\n• Разработка и поддержка сервисов: ${used}.`
		);
		remaining -= months;
		end = new Date(from.getTime() - 30 * DAY);
	}
	const title = `${data.roles.gradeTitles[input.grade] ?? ''} ${input.role.title} (${stack.label})`.trim();
	const middle = input.name.middleName === null ? '' : ` ${input.name.middleName}`;
	return [
		`${input.name.lastName} ${input.name.firstName}${middle}`,
		'Желаемая должность',
		title,
		'Опыт работы',
		...jobs,
		'Навыки',
		skills.map(nameOf).join(', '),
		'Образование',
		`${rnd.pick(UNIVERSITIES)}, ${input.now.getUTCFullYear() - input.age + 22}`
	].join('\n\n');
}

/** A synthetic candidate without FSP history: the profile rests on an uploaded resume. */
export function resumePlan(
	index: number,
	data: SeedData,
	batch: string,
	now: Date,
	skillNames: ReadonlyMap<string, string>,
	reach: OutcomeReach
): CandidatePlan {
	const rnd = new Random(`${batch}:resume:${index}`);
	const synthetic = syntheticName(rnd);
	const name: PersonName = {
		lastName: synthetic.lastName,
		firstName: synthetic.firstName,
		middleName: synthetic.middleName
	};
	const age = rnd.int(22, 42);
	const role = pickRole(data, rnd);
	const grade = gradeOfAge(age, rnd);
	const region = regionCodeOf(data, syntheticRegion(rnd), `synthetic resume ${index}`);
	const stack = rnd.pick(role.stacks);
	const text = resumeText(data, rnd, { name, role, stack, grade, age, now, skillNames });
	return {
		key: `resume:${index}`,
		email: `${translit(name.firstName)}.${translit(name.lastName)}.${index}@candidates.example`,
		name,
		birthDate: birthDateOf(rnd, now.getUTCFullYear() - age),
		athlete: null,
		catalogScope: rnd.chance(0.9) ? [] : null,
		desiredRoles: [role.key],
		preferences: {
			...workTerms(rnd, false),
			region_code: region,
			...(rnd.chance(0.85) ? { salary_expectation: expectation(data, rnd, role.key, grade) } : {})
		},
		searchStatus: rnd.chance(0.7) ? 'active' : 'open_to_offers',
		resume: { declaredName: `Резюме ${name.lastName}.txt`, bytes: new TextEncoder().encode(text) },
		github: null,
		profile: { headline: headlineOf(data, grade, role), softSkills: softSkillsOf(rnd), experience: [] },
		assessments: listOf(assessmentOf(data, rnd, [role.key], grade, stack, reach))
	};
}

/** A synthetic minor of the product discipline whose representative's authority is verified. */
export function minorPlan(athlete: WorldAthlete, batch: string): CandidatePlan {
	const rnd = new Random(`${batch}:minor:${athlete.fspId}`);
	return {
		key: `minor:${athlete.fspId}`,
		email: athlete.email,
		name: { lastName: athlete.lastName, firstName: athlete.firstName, middleName: athlete.middleName },
		birthDate: birthDateOf(rnd, athlete.birthYear),
		athlete,
		// Shown in the catalog after the representative's authority is verified (scenes.ts).
		catalogScope: null,
		desiredRoles: ['frontend'],
		preferences: { work_formats: ['remote'], employment_forms: ['internship'], relocation: false },
		searchStatus: 'active',
		resume: null,
		github: null,
		profile: null,
		assessments: []
	};
}

// --- Companies ---------------------------------------------------------------------------------------------------------

export interface CompanyPlan {
	key: string;
	displayName: string;
	legalName: string;
	inn: string;
	status: 'verified' | 'submitted';
	minorTerms: boolean;
	partnership: SeedData['demo']['companies'][number]['partnership'] | null;
	members: { key: string; role: 'owner' | 'recruiter'; email: string; displayName: string }[];
	/** Companies of the scenario get fixed vacancies besides the generated ones. */
	scenario: boolean;
}

const WEIGHTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];

/**
 * A 10-digit ИНН with a correct check digit and the tax office code 00, which no office has: the number passes the
 * checksum and cannot belong to a registered organization.
 */
function syntheticInn(key: string): string {
	const digest = createHash('sha256').update(`inn:${key}`).digest();
	const body = `00${String(digest.readUInt32BE(0) % 10_000_000).padStart(7, '0')}`;
	const digits = Array.from({ length: body.length }, (_, index) => body.charCodeAt(index) - 48);
	const check = (WEIGHTS_10.reduce((sum, weight, i) => sum + weight * (digits[i] ?? 0), 0) % 11) % 10;
	return `${body}${check}`;
}

const slug = (name: string) =>
	translit(name)
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

export function companyPlans(data: SeedData, batch: string): CompanyPlan[] {
	const scenario: CompanyPlan[] = data.demo.companies.map((company) => ({
		key: company.key,
		displayName: company.displayName,
		legalName: company.legalName,
		inn: syntheticInn(company.key),
		status: company.status,
		minorTerms: company.minorTerms,
		partnership: company.partnership ?? null,
		members: company.members,
		scenario: true
	}));
	const background = data.companies.companies.map((displayName, index): CompanyPlan => {
		const rnd = new Random(`${batch}:company:${displayName}`);
		const domain = `${slug(displayName)}.example`;
		const owner = syntheticName(rnd);
		const recruiter = syntheticName(rnd);
		return {
			key: `company_${index}`,
			displayName,
			legalName: `ООО «${displayName}»`,
			inn: syntheticInn(`company:${displayName}`),
			// Every seventh company is still under review: its offers carry the mark «не проверена».
			status: index % 7 === 6 ? 'submitted' : 'verified',
			minorTerms: false,
			partnership: null,
			members: [
				{
					key: `company_${index}_owner`,
					role: 'owner',
					email: `owner@${domain}`,
					displayName: `${owner.firstName} ${owner.lastName}`
				},
				{
					key: `company_${index}_recruiter`,
					role: 'recruiter',
					email: `hr@${domain}`,
					displayName: `${recruiter.firstName} ${recruiter.lastName}`
				}
			],
			scenario: false
		};
	});
	return [...scenario, ...background];
}

// --- Needs ----------------------------------------------------------------------------------------------------------

/** A need of a background company and the offers it sends from its shortlist (domain 13.10). */
export interface NeedPlan {
	company: string;
	/** `null` — the employer filled only the form. */
	text: string | null;
	form: NeedForm;
	/** How many of the best of the shortlist get an offer. */
	offers: number;
	terms: {
		title: string;
		description: string;
		salaryMin: number;
		salaryMax: number;
		taxBase: 'net' | 'gross';
		workFormat: string;
		contact: { kind: string; value: string };
		message: string | null;
	};
}

const OFFER_FORMATS = ['remote', 'hybrid', 'office'] as const;

/**
 * Two needs of every background company, for roles a test of the catalog checks; a need of a specialization without a
 * released bank is left to the seed to skip, so a bank released later adds its needs without a change here.
 */
export function needPlans(data: SeedData, companies: readonly CompanyPlan[], batch: string): NeedPlan[] {
	const tested = data.roles.roles.filter((role) => specializationsOfRole(role.key).length > 0);
	const plans: NeedPlan[] = [];
	for (const company of companies.filter((c) => !c.scenario)) {
		const rnd = new Random(`${batch}:needs:${company.key}`);
		const domain = company.members[0]?.email.split('@')[1] ?? 'company.example';
		for (let i = 0; i < 2; i++) {
			const role = rnd.weighted(tested.map((r) => [r, r.weight] as const));
			const specialization = specializationsOfRole(role.key)[0];
			const stack = rnd.pick(role.stacks);
			const grade = rnd.weighted<GradeKey>([
				['junior', 0.3],
				['middle', 0.45],
				['senior', 0.25]
			]);
			const next = GRADE_KEYS[GRADE_KEYS.indexOf(grade) + 1];
			const max = next !== undefined && rnd.chance(0.4) ? next : grade;
			const [low] = band(data, grade, role.multiplier);
			const [, high] = band(data, max, role.multiplier);
			const salary = { min: round5k(low), max: round5k(high) };
			const workFormat = rnd.pick(OFFER_FORMATS);
			const title = `${data.roles.gradeTitles[grade] ?? ''} ${role.title} (${stack.label})`.trim();
			const nice = stack.nice.filter(() => rnd.chance(0.5));
			plans.push({
				company: company.key,
				text: rnd.chance(0.6)
					? `«${company.displayName}» ищет: ${title}. Стек: ${stack.label}. Формат — ${FORMAT_NAMES[workFormat] ?? workFormat}, вилка ${salary.min}–${salary.max} ₽ на руки.`
					: null,
				form: {
					role_key: role.key,
					...(specialization === undefined ? {} : { specialization }),
					grade: { min: grade, max },
					skill_keys: [...stack.required],
					nice_skill_keys: nice,
					work_format: workFormat,
					salary: { ...salary, currency: 'RUB', period: 'month', tax_base: 'net' },
					fsp_relevant: rnd.chance(0.5)
				},
				offers: rnd.int(2, 5),
				terms: {
					title,
					description: `«${company.displayName}» предлагает роль: ${title}. Задачи команды, стек ${stack.label} и условия обсудим на созвоне, ответим на вопросы.`,
					salaryMin: salary.min,
					salaryMax: salary.max,
					taxBase: 'net',
					workFormat,
					contact: { kind: 'email', value: `hr@${domain}` },
					message: null
				}
			});
		}
	}
	return plans;
}

// --- Vacancies -------------------------------------------------------------------------------------------------------

export interface OwnVacancyPlan {
	/** Key of the company in the plans. */
	company: string;
	/** Set only on the scenario's vacancies, which the seed finds by it. */
	scenarioKey: string | null;
	input: {
		title: string;
		description: string;
		roleKey: string;
		gradeMin: string;
		gradeMax: string;
		requiredSkillKeys: string[];
		niceSkillKeys: string[];
		workFormat: string;
		employmentForm: string;
		contractTypes: string[];
		cityId: null;
		timezoneOverlapHours: null;
		salary: { min: number; max: number; currency: 'RUB'; period: 'month'; taxBase: 'net' | 'gross' };
		/** Internship open to candidates from this age (domain 7.3); needs the company's acceptance of the terms. */
		minAge: number | null;
	};
}

const GRADES = ['intern', 'junior', 'middle', 'senior', 'lead'] as const;
const FORMAT_NAMES: Record<string, string> = { office: 'офис', hybrid: 'гибрид', remote: 'удалённая работа' };

function description(
	company: string,
	title: string,
	required: readonly string[],
	nice: readonly string[],
	workFormat: string,
	internship: boolean
): string {
	const lines = [
		`«${company}» ищет в команду: ${title}.`,
		'Задачи: разработка и развитие продуктовых сервисов, участие в проектировании, код-ревью, работа с командой продукта.',
		`Обязательно: ${required.join(', ')}.`,
		...(nice.length > 0 ? [`Будет плюсом: ${nice.join(', ')}.`] : []),
		`Условия: ${FORMAT_NAMES[workFormat] ?? workFormat}, ${internship ? 'стажировка с наставником' : 'полная занятость'}, оформление по ТК РФ.`
	];
	return lines.join('\n\n');
}

function vacancyTerms(
	data: SeedData,
	rnd: Random,
	role: RoleProfile,
	company: string,
	skillNames: ReadonlyMap<string, string>
): OwnVacancyPlan['input'] {
	const stack = rnd.pick(role.stacks);
	const grade = rnd.weighted<(typeof GRADES)[number]>([
		['intern', 0.05],
		['junior', 0.2],
		['middle', 0.4],
		['senior', 0.28],
		['lead', 0.07]
	]);
	const next = GRADES[GRADES.indexOf(grade) + 1];
	const gradeMax = next !== undefined && grade !== 'intern' && rnd.chance(0.35) ? next : grade;
	const [low, high] = band(data, grade, role.multiplier);
	const [, highMax] = band(data, gradeMax, role.multiplier);
	const net = rnd.chance(0.7);
	const factor = net ? 1 : 1 / 0.87;
	const min = round5k((low + (high - low) * rnd.next() * 0.5) * factor);
	const max = Math.max(min, round5k((high + (highMax - high) * rnd.next()) * factor));
	const nice = stack.nice.filter(() => rnd.chance(0.5));
	const workFormat = rnd.weighted<string>([
		['remote', 0.35],
		['hybrid', 0.4],
		['office', 0.25]
	]);
	const internship = grade === 'intern';
	const title = `${data.roles.gradeTitles[grade] ?? ''} ${role.title} (${stack.label})`.trim();
	const names = (keys: readonly string[]) => keys.map((key) => skillNames.get(key) ?? key);
	return {
		title,
		description: description(company, title, names(stack.required), names(nice), workFormat, internship),
		roleKey: role.key,
		gradeMin: grade,
		gradeMax,
		requiredSkillKeys: [...stack.required],
		niceSkillKeys: nice,
		workFormat,
		employmentForm: internship ? 'internship' : 'full',
		contractTypes: rnd.chance(0.2) ? ['labor', 'self_employed'] : ['labor'],
		cityId: null,
		timezoneOverlapHours: null,
		salary: { min, max, currency: 'RUB', period: 'month', taxBase: net ? 'net' : 'gross' },
		minAge: null
	};
}

/**
 * Vacancies of the scenario's main employer: the internship open from 16, the two of the invitations, the one of
 * Python payouts a Python Middle without offers applies to on stage, and three written texts — Backend, QA, Data
 * Science — whose pages show how the test of a vacancy is made of its text (domain 13.11).
 */
function scenarioVacancies(companyKey: string, companyName: string): OwnVacancyPlan[] {
	const fixed = (
		scenarioKey: string,
		input: Omit<OwnVacancyPlan['input'], 'description' | 'cityId' | 'timezoneOverlapHours' | 'minAge'> & {
			niceNames: string[];
			requiredNames: string[];
		},
		minAge: number | null
	): OwnVacancyPlan => {
		const { niceNames, requiredNames, ...rest } = input;
		return written(
			scenarioKey,
			{
				...rest,
				description: description(
					companyName,
					rest.title,
					requiredNames,
					niceNames,
					rest.workFormat,
					rest.employmentForm === 'internship'
				)
			},
			minAge
		);
	};
	const written = (
		scenarioKey: string,
		input: Omit<OwnVacancyPlan['input'], 'cityId' | 'timezoneOverlapHours' | 'minAge'>,
		minAge: number | null = null
	): OwnVacancyPlan => ({
		company: companyKey,
		scenarioKey,
		input: { ...input, cityId: null, timezoneOverlapHours: null, minAge }
	});
	return [
		fixed(
			'internship_frontend',
			{
				title: 'Стажёр frontend-разработки',
				roleKey: 'frontend',
				gradeMin: 'intern',
				gradeMax: 'intern',
				requiredSkillKeys: ['javascript', 'html', 'css'],
				requiredNames: ['JavaScript', 'HTML', 'CSS'],
				niceSkillKeys: ['typescript', 'react'],
				niceNames: ['TypeScript', 'React'],
				workFormat: 'remote',
				employmentForm: 'internship',
				contractTypes: ['labor'],
				salary: { min: 45_000, max: 60_000, currency: 'RUB', period: 'month', taxBase: 'net' }
			},
			16
		),
		fixed(
			'python_senior',
			{
				title: 'Senior Python-разработчик (платформа логистики)',
				roleKey: 'backend',
				gradeMin: 'senior',
				gradeMax: 'senior',
				requiredSkillKeys: ['python', 'postgresql'],
				requiredNames: ['Python', 'PostgreSQL'],
				niceSkillKeys: ['fastapi', 'celery', 'docker'],
				niceNames: ['FastAPI', 'Celery', 'Docker'],
				workFormat: 'hybrid',
				employmentForm: 'full',
				contractTypes: ['labor'],
				salary: { min: 360_000, max: 450_000, currency: 'RUB', period: 'month', taxBase: 'net' }
			},
			null
		),
		fixed(
			'python_payouts',
			{
				title: 'Middle Python-разработчик (сервис выплат партнёрам)',
				roleKey: 'backend',
				gradeMin: 'middle',
				gradeMax: 'middle',
				requiredSkillKeys: ['python', 'postgresql'],
				requiredNames: ['Python', 'PostgreSQL'],
				niceSkillKeys: ['fastapi', 'docker'],
				niceNames: ['FastAPI', 'Docker'],
				workFormat: 'hybrid',
				employmentForm: 'full',
				contractTypes: ['labor'],
				salary: { min: 200_000, max: 260_000, currency: 'RUB', period: 'month', taxBase: 'net' }
			},
			null
		),
		fixed(
			'go_payments',
			{
				title: 'Middle Go-разработчик (платёжный шлюз)',
				roleKey: 'backend',
				gradeMin: 'middle',
				gradeMax: 'senior',
				requiredSkillKeys: ['go', 'postgresql'],
				requiredNames: ['Go', 'PostgreSQL'],
				niceSkillKeys: ['kafka', 'kubernetes'],
				niceNames: ['Apache Kafka', 'Kubernetes'],
				workFormat: 'hybrid',
				employmentForm: 'full',
				contractTypes: ['labor'],
				salary: { min: 230_000, max: 290_000, currency: 'RUB', period: 'month', taxBase: 'net' }
			},
			null
		),
		written('test_spec_backend', {
			title: 'Middle Java-разработчик (биллинг подписок)',
			description: [
				`«${companyName}» развивает биллинг подписок: списания, возвраты и счета для 4 млн клиентов, сотни тысяч транзакций в сутки.`,
				'Задачи: писать сервисы расчёта и списаний, проектировать REST API для партнёров, ускорять запросы к PostgreSQL, разбирать гонки при параллельной обработке платежей.',
				'Требования: Java, SQL, PostgreSQL, REST API, многопоточность.',
				'Будет плюсом: Apache Kafka, Spring Boot, Redis, Camunda.',
				'Условия: гибрид, полная занятость, оформление по ТК РФ.'
			].join('\n\n'),
			roleKey: 'backend',
			gradeMin: 'middle',
			gradeMax: 'middle',
			requiredSkillKeys: ['java', 'sql', 'postgresql', 'rest', 'multithreading'],
			niceSkillKeys: ['kafka', 'spring_boot', 'redis'],
			workFormat: 'hybrid',
			employmentForm: 'full',
			contractTypes: ['labor'],
			salary: { min: 240_000, max: 300_000, currency: 'RUB', period: 'month', taxBase: 'net' }
		}),
		written('test_spec_qa', {
			title: 'Junior QA-инженер (автотесты API)',
			description: [
				`«${companyName}» ищет QA-инженера в команду мобильного банка: релиз раз в две недели, 1 200 автотестов API в регрессе.`,
				'Задачи: проектировать проверки по требованиям, заводить и разбирать дефекты, писать автотесты API на pytest, сверять данные в базе запросами.',
				'Требования: тест-дизайн, автотесты, pytest, REST API, SQL.',
				'Будет плюсом: Postman, нагрузочное тестирование, Allure TestOps.',
				'Условия: удалённая работа, полная занятость, оформление по ТК РФ.'
			].join('\n\n'),
			roleKey: 'qa_automation',
			gradeMin: 'junior',
			gradeMax: 'junior',
			requiredSkillKeys: ['manual_testing', 'test_automation', 'pytest', 'rest', 'sql'],
			niceSkillKeys: ['postman', 'jmeter'],
			workFormat: 'remote',
			employmentForm: 'full',
			contractTypes: ['labor'],
			salary: { min: 110_000, max: 150_000, currency: 'RUB', period: 'month', taxBase: 'net' }
		}),
		written('test_spec_ml', {
			title: 'Data Scientist (прогноз спроса)',
			description: [
				`«${companyName}» строит прогноз спроса для сети из 900 магазинов: 40 тыс. товаров, пересчёт каждую ночь.`,
				'Задачи: готовить данные из хранилища, строить и проверять модели прогноза, выбирать метрики качества, оценивать эффект изменений.',
				'Требования: Python, статистика, машинное обучение, SQL, pandas.',
				'Будет плюсом: CatBoost, Apache Airflow, глубокое обучение, Prophet.',
				'Условия: удалённая работа, полная занятость, оформление по ТК РФ.'
			].join('\n\n'),
			roleKey: 'data_scientist',
			gradeMin: 'junior',
			gradeMax: 'middle',
			requiredSkillKeys: ['python', 'statistics', 'ml', 'sql', 'pandas'],
			niceSkillKeys: ['catboost', 'airflow', 'dl'],
			workFormat: 'remote',
			employmentForm: 'full',
			contractTypes: ['labor'],
			salary: { min: 150_000, max: 260_000, currency: 'RUB', period: 'month', taxBase: 'net' }
		})
	];
}

/** Own vacancies of the verified companies: `count` in total, the scenario's main employer first. */
export function ownVacancyPlans(
	data: SeedData,
	companies: readonly CompanyPlan[],
	count: number,
	batch: string,
	skillNames: ReadonlyMap<string, string>
): OwnVacancyPlan[] {
	const verified = companies.filter((c) => c.status === 'verified');
	const main = verified.find((c) => c.minorTerms);
	const plans: OwnVacancyPlan[] = main ? scenarioVacancies(main.key, main.displayName) : [];
	const rnd = new Random(`${batch}:vacancies:own`);
	for (let i = 0; plans.length < count; i++) {
		// The scenario's companies publish more than the background ones.
		const company = rnd.weighted(verified.map((c) => [c, c.scenario ? 3 : 1] as const));
		plans.push({
			company: company.key,
			scenarioKey: null,
			input: vacancyTerms(data, rnd, pickRole(data, rnd), company.displayName, skillNames)
		});
	}
	return plans;
}
