// Deterministic dataset: real FSP competitions (catalog.ts) with synthetic athletes, teams, places and ranks.
// The same seed and size always give the same data, including ids.

import { createHash } from 'node:crypto';

import type { Account, DemoAccount } from '../accounts.ts';
import type { AthleteRecord, World } from '../store.ts';
import type {
	AgeGroup,
	Athlete,
	Award,
	Competition,
	CompetitionLevel,
	DisciplineCode,
	EvskRank,
	PlatformAccount,
	Qualification,
	Result,
	ResultTeam,
	TeamRole
} from '../types.ts';
import { CATALOG, type CatalogEntry } from './catalog.ts';
import { SPECIALIZATIONS, TEAM_SIZE } from './disciplines.ts';
import { assigningAuthority, evskFulfilled } from './evsk.ts';
import { HEROES, SERVICE_ACCOUNTS, type HeroEntry, type HeroSpec } from './heroes.ts';
import {
	syntheticLogin,
	syntheticName,
	syntheticRegion,
	syntheticTeamName,
	translit,
	type SyntheticName
} from './names.ts';
import { Random } from './random.ts';

/** Bump when the generator changes the data it produces for the same seed. */
const GENERATOR_VERSION = 1;
/** The generated history ends here: later competitions have no results yet. */
export const DATASET_AS_OF = '2026-09-24';
/** Results of competitions that ended within this many days before DATASET_AS_OF are still preliminary. */
const PRELIMINARY_DAYS = 10;

interface Person {
	fspId: string;
	name: SyntheticName;
	birthYear: number;
	region: string;
	disciplines: DisciplineCode[];
	skill: number;
	activity: number;
	hero: HeroSpec | null;
}

interface Team {
	id: string;
	name: string;
	region: string;
	discipline: DisciplineCode;
	members: { person: Person; role: TeamRole; specialization: string | null | undefined }[];
	trainer: Person | null;
	skill: number;
}

/** One line of a competition's standings before places are assigned. */
type Entry =
	| { kind: 'individual'; person: Person; perf: number; forcedPlace?: number; hero?: HeroEntry }
	| { kind: 'team'; team: Team; perf: number; forcedPlace?: number; hero?: HeroEntry };

export interface GenerateOptions {
	seed: string;
	athletes: number;
}

const DAY_MS = 24 * 3600 * 1000;

function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function yearOf(date: string): number {
	return Number(date.slice(0, 4));
}

function eligibleAge(ageGroup: AgeGroup, age: number): boolean {
	switch (ageGroup) {
		case 'boys_girls_u15':
			return age >= 12 && age <= 14;
		case 'juniors_u19':
			return age >= 14 && age <= 18;
		case 'juniors_u26':
			return age >= 17 && age <= 25;
		case 'adults':
			return age >= 16;
	}
}

const DEFAULT_FIELD: Record<CompetitionLevel, number> = {
	world_championship: 60,
	european_championship: 50,
	international_ekp: 60,
	russian_championship: 60,
	russian_cup: 40,
	russian_youth_championship: 50,
	all_russian_ekp: 150,
	all_russian_sport_event: 200,
	universiade: 50,
	federal_district: 60,
	interregional_ekp: 60,
	regional_championship: 40,
	regional_cup: 30,
	regional_youth: 40,
	regional_other: 40,
	municipal: 25,
	accredited: 80,
	unofficial: 60
};

const MAX_INDIVIDUALS = 220;
const MAX_TEAMS = 60;
/** Share of a qualifier that advances to the final of the same cup. */
const QUALIFIER_QUOTA = 0.3;

const REGIONAL_LEVELS: ReadonlySet<string> = new Set([
	'regional_championship',
	'regional_cup',
	'regional_youth',
	'regional_other',
	'municipal'
]);

/** Weighted sampling without replacement (Efraimidis–Spirakis). */
function sample<T>(rnd: Random, items: readonly T[], weight: (item: T) => number, count: number): T[] {
	return items
		.map((item) => ({ item, key: Math.log(1 - rnd.next()) / Math.max(weight(item), 1e-9) }))
		.sort((a, b) => b.key - a.key)
		.slice(0, count)
		.map((x) => x.item);
}

function birthYear(rnd: Random): number {
	return rnd.weighted([
		[rnd.int(2010, 2012), 0.14],
		[rnd.int(2006, 2009), 0.3],
		[rnd.int(1999, 2005), 0.4],
		[rnd.int(1986, 1998), 0.16]
	]);
}

function makePeople(rnd: Random, count: number): Person[] {
	const people: Person[] = [];
	for (let i = 0; i < count; i++) {
		const primary = rnd.weighted<DisciplineCode>([
			['algorithmic', 0.4],
			['product', 0.25],
			['infosec', 0.17],
			['robotics', 0.1],
			['uas', 0.08]
		]);
		const disciplines: DisciplineCode[] = [primary];
		if (rnd.chance(0.25)) {
			const second = rnd.pick<DisciplineCode>(['algorithmic', 'product', 'infosec', 'robotics', 'uas']);
			if (second !== primary) disciplines.push(second);
		}
		people.push({
			fspId: rnd.uuid(),
			name: syntheticName(rnd),
			birthYear: birthYear(rnd),
			region: syntheticRegion(rnd),
			disciplines,
			skill: rnd.normal(),
			activity: 0.3 + rnd.next() * 1.7,
			hero: null
		});
	}
	return people;
}

function heroPerson(spec: HeroSpec): Person {
	return {
		fspId: spec.fspId,
		name: spec.name,
		birthYear: spec.birthYear,
		region: spec.region,
		disciplines: spec.disciplines,
		skill: spec.skill,
		activity: spec.randomActivity ? 1.5 : 0,
		hero: spec
	};
}

function bandOf(person: Person): 'youth' | 'adult' {
	return person.birthYear >= 2008 ? 'youth' : 'adult';
}

function teamSpecialization(rnd: Random, discipline: DisciplineCode, known: boolean): string | null | undefined {
	const options = SPECIALIZATIONS[discipline];
	if (options.length === 0) return undefined;
	if (!known) return rnd.chance(0.5) ? null : undefined;
	return rnd.pick(options);
}

function formTeams(rnd: Random, people: readonly Person[]): Team[] {
	const teams: Team[] = [];
	const trainers = people.filter((p) => !p.hero && p.birthYear <= 1998);
	for (const discipline of ['product', 'robotics', 'infosec', 'algorithmic'] as const) {
		const groups = new Map<string, Person[]>();
		for (const person of people) {
			if (person.hero || !person.disciplines.includes(discipline)) continue;
			// In algorithmic programming teams exist only in student competitions: a minority forms them.
			if (discipline === 'algorithmic' && !rnd.chance(0.25)) continue;
			const key = `${person.region}|${bandOf(person)}`;
			groups.set(key, [...(groups.get(key) ?? []), person]);
		}
		for (const [key, members] of groups) {
			const [region = ''] = key.split('|');
			rnd.shuffle(members);
			const [minSize, maxSize] = TEAM_SIZE[discipline];
			let offset = 0;
			while (members.length - offset >= minSize) {
				const size = Math.min(rnd.int(minSize, maxSize), members.length - offset);
				const roster = members.slice(offset, offset + size);
				offset += size;
				const specsKnown = rnd.chance(0.55);
				teams.push({
					id: rnd.uuid(),
					name: syntheticTeamName(rnd, region),
					region,
					discipline,
					members: roster.map((person, i) => ({
						person,
						role:
							i === 0 ? 'captain' : i === roster.length - 1 && size >= 4 && rnd.chance(0.25) ? 'reserve' : 'athlete',
						specialization: teamSpecialization(rnd, discipline, specsKnown)
					})),
					trainer: rnd.chance(0.6) ? (trainers.find((t) => t.region === region && rnd.chance(0.3)) ?? null) : null,
					skill:
						roster.reduce((sum, p) => sum + p.skill, 0) / roster.length + 0.3 * Math.max(...roster.map((p) => p.skill))
				});
			}
		}
	}
	return teams;
}

function competitionOf(entry: CatalogEntry): Competition {
	const { rawLevel, ageGroupKnown, ageGroup, ...rest } = entry;
	const competition: Competition = { ...rest, ...(ageGroupKnown === false ? {} : { ageGroup }) };
	if (rawLevel !== undefined) competition.rawValues = { level: rawLevel };
	return competition;
}

function matches(entry: CatalogEntry, hero: HeroEntry): boolean {
	const s = hero.select;
	return (
		entry.discipline === s.discipline &&
		(s.level === undefined || entry.level === s.level) &&
		(s.stage === undefined || entry.stage === s.stage) &&
		(s.year === undefined || yearOf(entry.startDate) === s.year) &&
		(s.ageGroup === undefined || entry.ageGroup === s.ageGroup) &&
		(s.online === undefined || entry.online === s.online) &&
		(s.format === undefined || entry.format === s.format)
	);
}

function knownLevel(entry: CatalogEntry): CompetitionLevel | null {
	return entry.level === 'unknown' ? null : entry.level;
}

function scoreFields(
	rnd: Random,
	discipline: DisciplineCode,
	index: number,
	count: number,
	previous: Pick<Result, 'score' | 'solved' | 'penaltyMinutes'> | null
): Pick<Result, 'score' | 'solved' | 'penaltyMinutes'> {
	const x = count <= 1 ? 0 : index / (count - 1);
	switch (discipline) {
		case 'algorithmic': {
			const tasks = 10;
			let solved = Math.max(0, Math.round(tasks * (1 - x ** 0.8) + rnd.normal() * 0.4));
			if (previous?.solved != null) solved = Math.min(solved, previous.solved);
			const floor = previous?.solved === solved && previous.penaltyMinutes != null ? previous.penaltyMinutes + 1 : 60;
			return { solved, penaltyMinutes: Math.max(floor, rnd.int(150, 900) - solved * 20) };
		}
		case 'product': {
			let score = Math.round((380 * (1 - 0.85 * x) + rnd.normal() * 8) * 10) / 10;
			if (previous?.score != null) score = Math.min(score, previous.score);
			return { score };
		}
		case 'infosec': {
			let score = Math.round(14000 * (1 - 0.95 * x ** 0.7) + rnd.normal() * 150);
			if (previous?.score != null) score = Math.min(score, previous.score);
			return { score: Math.max(0, score) };
		}
		case 'robotics':
		case 'uas': {
			let score = Math.round(1000 * (1 - 0.9 * x) + rnd.normal() * 15);
			if (previous?.score != null) score = Math.min(score, previous.score);
			return { score: Math.max(0, score) };
		}
	}
}

function awardFor(stage: CatalogEntry['stage'], place: number, advanced: boolean): Award {
	if (place === 1 && stage !== 'qualifier') return 'winner';
	if (place <= 3 && stage !== 'qualifier') return 'prize';
	if (stage === 'final') return 'finalist';
	if (stage === 'qualifier' && advanced) return 'finalist';
	return 'participant';
}

function nextRank(rank: EvskRank): EvskRank[] {
	const order: EvskRank[] = ['MS', 'KMS', 'I', 'II', 'III', 'Y1', 'Y2', 'Y3'];
	return order.slice(0, order.indexOf(rank));
}

function orderNumber(rnd: Random, rank: EvskRank): string {
	if (rank === 'MS') return `${rnd.int(10, 250)} нг`;
	if (rank === 'KMS' || rank === 'I') return `${rnd.int(100, 2400)}-п`;
	return `${rnd.int(10, 900)}-о`;
}

function validUntil(rank: EvskRank, assignedAt: string): string | null {
	if (rank === 'MS') return null;
	const years = rank === 'KMS' ? 3 : 2;
	return `${yearOf(assignedAt) + years}${assignedAt.slice(4)}`;
}

export function generateWorld(options: GenerateOptions): World {
	const rnd = new Random(`${options.seed}:${options.athletes}`);
	const datasetId = createHash('sha256')
		.update(`${options.seed}:${options.athletes}:${GENERATOR_VERSION}`)
		.digest('hex')
		.slice(0, 10);

	const heroes = HEROES.map(heroPerson);
	const people = [...heroes, ...makePeople(rnd, options.athletes - heroes.length)];
	const teams = formTeams(rnd, people);

	const records = new Map<string, AthleteRecord>();
	for (const person of people) {
		const athlete: Athlete = {
			fspId: person.fspId,
			lastName: person.name.lastName,
			firstName: person.name.firstName,
			middleName: person.name.middleName,
			birthYear: person.birthYear,
			region: person.region
		};
		records.set(person.fspId, { athlete, results: [], qualifications: [], revision: 1 });
	}
	const recordOf = (person: Person): AthleteRecord => {
		const record = records.get(person.fspId);
		if (!record) throw new Error(`no record for ${person.fspId}`);
		return record;
	};

	const competitions = new Map<string, Competition>();
	for (const entry of CATALOG) competitions.set(entry.id, competitionOf(entry));

	// Every hero entry must land in a real past competition of the catalog.
	const heroEntries = new Map<string, { person: Person; entry: HeroEntry }[]>();
	for (const person of heroes) {
		const spec = person.hero;
		if (!spec) continue;
		const entries = [...spec.entries];
		for (const [i, comp] of CATALOG.filter(
			(c) =>
				c.startDate <= DATASET_AS_OF &&
				(spec.enterAllOf ?? []).includes(c.discipline) &&
				eligibleAge(c.ageGroup, yearOf(c.startDate) - spec.birthYear)
		).entries()) {
			entries.push({
				select: {
					discipline: comp.discipline,
					level: comp.level,
					stage: comp.stage,
					year: yearOf(comp.startDate),
					ageGroup: comp.ageGroup,
					format: comp.format
				},
				place: 2 + ((i * 5) % 17),
				role: 'athlete'
			});
		}
		for (const entry of entries) {
			const target = CATALOG.find(
				(c) =>
					c.startDate <= DATASET_AS_OF &&
					matches(c, entry) &&
					!(heroEntries.get(c.id) ?? []).some((h) => h.person === person)
			);
			if (!target)
				throw new Error(`hero ${person.hero?.key ?? ''}: no competition matches ${JSON.stringify(entry.select)}`);
			heroEntries.set(target.id, [...(heroEntries.get(target.id) ?? []), { person, entry }]);
		}
	}

	const advancedFrom = new Map<string, Set<string>>(); // qualifier key -> fspIds of those who advanced
	const cupKey = (c: CatalogEntry) => `${c.discipline}|${c.level}|${yearOf(c.startDate)}|${c.ageGroup}`;
	const past = CATALOG.filter((c) => c.startDate <= DATASET_AS_OF).sort((a, b) =>
		a.startDate.localeCompare(b.startDate)
	);

	for (const comp of past) {
		const year = yearOf(comp.startDate);
		const level = knownLevel(comp);
		const regionOnly = REGIONAL_LEVELS.has(comp.level)
			? (people.find((p) => comp.location?.includes(p.region.replace(/ область| край|Республика /g, '').trim()))
					?.region ?? syntheticRegion(rnd))
			: null;
		const forced = heroEntries.get(comp.id) ?? [];
		const forcedIds = new Set(forced.map((f) => f.person.fspId));
		const qualified = comp.stage === 'final' ? advancedFrom.get(cupKey(comp)) : undefined;
		const eligible = (p: Person) =>
			(p.hero === null || (p.hero.randomActivity && !forcedIds.has(p.fspId))) &&
			p.disciplines.includes(comp.discipline) &&
			eligibleAge(comp.ageGroup, year - p.birthYear) &&
			(regionOnly === null || p.region === regionOnly);
		const levelSkillWeight =
			level !== null &&
			['russian_championship', 'russian_cup', 'world_championship', 'international_ekp'].includes(level)
				? 1.6
				: 0.8;
		const personWeight = (p: Person) =>
			p.activity * Math.exp(levelSkillWeight * p.skill) * (qualified?.has(p.fspId) ? 50 : 1);

		const defaultField = DEFAULT_FIELD[level ?? 'unofficial'];
		const entries: Entry[] = [];
		if (comp.format === 'individual') {
			const target = Math.min(comp.participantsCount ?? defaultField, MAX_INDIVIDUALS);
			const pool = people.filter(eligible);
			for (const person of sample(rnd, pool, personWeight, Math.max(target - forced.length, 0))) {
				entries.push({ kind: 'individual', person, perf: person.skill + 0.7 * rnd.normal() });
			}
			for (const f of forced) {
				entries.push({ kind: 'individual', person: f.person, perf: 0, forcedPlace: f.entry.place, hero: f.entry });
			}
		} else {
			// Large published counts are people (athletes and a coach per team), small ones are teams.
			const avgSize = (TEAM_SIZE[comp.discipline][0] + TEAM_SIZE[comp.discipline][1]) / 2 + 1;
			const target = Math.min(
				Math.ceil(
					(comp.participantsCount ?? defaultField * avgSize) /
						(comp.participantsCount !== undefined && comp.participantsCount <= 80 ? 1 : avgSize)
				),
				MAX_TEAMS
			);
			const pool = teams.filter(
				(t) =>
					t.discipline === comp.discipline &&
					t.members.every((m) => eligible(m.person)) &&
					!t.members.some((m) => forcedIds.has(m.person.fspId))
			);
			const teamWeight = (t: Team) =>
				(t.members.reduce((s, m) => s + m.person.activity, 0) / t.members.length) *
				Math.exp(levelSkillWeight * t.skill) *
				(qualified !== undefined && t.members.some((m) => qualified.has(m.person.fspId)) ? 50 : 1);
			for (const team of sample(rnd, pool, teamWeight, Math.max(target - forced.length, 0))) {
				entries.push({ kind: 'team', team, perf: team.skill + 0.7 * rnd.normal() });
			}
			const taken = new Set(
				entries.flatMap((e) => (e.kind === 'team' ? e.team.members.map((m) => m.person.fspId) : []))
			);
			for (const f of forced) {
				// A hero's team: the hero plus eligible athletes of the discipline who are not in the field yet.
				const [minSize, maxSize] = TEAM_SIZE[comp.discipline];
				const size = f.entry.teamSize ?? rnd.int(Math.max(minSize, 2), maxSize);
				const mates = sample(
					rnd,
					people.filter((p) => eligible(p) && !taken.has(p.fspId)),
					(p) => p.activity,
					size - 1
				);
				for (const m of mates) taken.add(m.fspId);
				const specsKnown = f.entry.specialization !== undefined && f.entry.specialization !== null;
				const heroRole = f.entry.role ?? 'athlete';
				const team: Team = {
					id: rnd.uuid(),
					name: f.entry.teamName ?? syntheticTeamName(rnd, f.person.region),
					region: f.person.region,
					discipline: comp.discipline,
					members: [
						{ person: f.person, role: heroRole, specialization: f.entry.specialization },
						...mates.map((person, i): Team['members'][number] => ({
							person,
							role: heroRole !== 'captain' && i === 0 ? 'captain' : 'athlete',
							specialization: teamSpecialization(rnd, comp.discipline, specsKnown)
						}))
					],
					trainer: null,
					skill: 0
				};
				entries.push({ kind: 'team', team, perf: 0, forcedPlace: f.entry.place, hero: f.entry });
			}
		}

		// Places: generated entries by performance, heroes inserted at the places their scenario needs.
		const free = entries.filter((e) => e.forcedPlace === undefined).sort((a, b) => b.perf - a.perf);
		const pinned = entries
			.filter((e) => e.forcedPlace !== undefined)
			.sort((a, b) => (a.forcedPlace ?? 0) - (b.forcedPlace ?? 0));
		const standings = [...free];
		for (const e of pinned) standings.splice(Math.min((e.forcedPlace ?? 1) - 1, standings.length), 0, e);

		const fieldSize = Math.max(
			standings.length,
			comp.participantsCount !== undefined && comp.format === 'individual' ? comp.participantsCount : standings.length
		);
		const quota = Math.max(1, Math.round(standings.length * QUALIFIER_QUOTA));
		const advanced = new Set<string>();
		const publishedAt = `${addDays(comp.endDate ?? comp.startDate, 2)}T15:00:00Z`;
		const recent = addDays(comp.endDate ?? comp.startDate, PRELIMINARY_DAYS) > DATASET_AS_OF;
		let previous: Pick<Result, 'score' | 'solved' | 'penaltyMinutes'> | null = null;
		// One result per person and competition: a coach who competes or already coaches another team is not listed again.
		const listed = new Set(
			standings.flatMap((e) => (e.kind === 'team' ? e.team.members.map((m) => m.person.fspId) : [e.person.fspId]))
		);

		standings.forEach((entry, index) => {
			const place = index + 1;
			const fields = scoreFields(rnd, comp.discipline, index, standings.length, previous);
			previous = fields;
			const isAdvanced = comp.stage === 'qualifier' && index < quota;
			const award = awardFor(comp.stage, place, isAdvanced);
			const status = entry.hero?.status ?? (recent ? 'preliminary' : rnd.chance(0.002) ? 'annulled' : 'official');
			const base = {
				competitionId: comp.id,
				place: status === 'annulled' && rnd.chance(0.5) ? null : place,
				placeOf: fieldSize,
				...fields,
				award,
				status,
				publishedAt
			} as const;
			const fulfilled = (person: Person): EvskRank | null =>
				level === null
					? null
					: evskFulfilled({
							level,
							stage: comp.stage,
							ageGroup: comp.ageGroup,
							discipline: comp.discipline,
							place,
							ageAtCompetition: year - person.birthYear
						});

			if (entry.kind === 'individual') {
				if (isAdvanced) advanced.add(entry.person.fspId);
				recordOf(entry.person).results.push({
					id: rnd.uuid(),
					...base,
					team: null,
					evskFulfilled: fulfilled(entry.person)
				});
				return;
			}
			const { team } = entry;
			const trainer = team.trainer && !listed.has(team.trainer.fspId) ? team.trainer : null;
			if (trainer) listed.add(trainer.fspId);
			const participants = [
				...team.members,
				...(trainer ? [{ person: trainer, role: 'trainer' as TeamRole, specialization: undefined }] : [])
			];
			for (const member of participants) {
				if (isAdvanced) advanced.add(member.person.fspId);
				const unknownRole = entry.hero?.rawRole ?? (rnd.chance(0.002) ? 'оператор' : undefined);
				const resultTeam: ResultTeam = {
					id: team.id,
					name: team.name,
					region: team.region,
					size: team.members.length,
					role: unknownRole !== undefined && member.person === entry.team.members[0]?.person ? 'unknown' : member.role
				};
				if (member.specialization !== undefined && member.role !== 'trainer')
					resultTeam.specialization = member.specialization;
				// A norm counts for competing members; reserves, trainers and unknown roles get none.
				const counts = resultTeam.role === 'captain' || resultTeam.role === 'athlete';
				const result: Result = {
					id: rnd.uuid(),
					...base,
					team: resultTeam,
					evskFulfilled: counts ? fulfilled(member.person) : null
				};
				if (resultTeam.role === 'unknown' && unknownRole !== undefined) result.rawValues = { 'team.role': unknownRole };
				recordOf(member.person).results.push(result);
			}
		});
		if (comp.stage === 'qualifier') advancedFrom.set(cupKey(comp), advanced);
	}

	// Ranks assigned on the basis of fulfilled norms: not everyone applies, and assignment takes one to four months.
	for (const person of people) {
		const record = recordOf(person);
		const best = new Map<DisciplineCode, EvskRank>();
		const chronological = [...record.results].sort((a, b) =>
			(competitions.get(a.competitionId)?.startDate ?? '').localeCompare(
				competitions.get(b.competitionId)?.startDate ?? ''
			)
		);
		for (const result of chronological) {
			const comp = competitions.get(result.competitionId);
			const rank = result.evskFulfilled;
			if (!comp || !rank || result.status !== 'official' || comp.discipline === 'unknown') continue;
			const current = best.get(comp.discipline);
			if (current !== undefined && !nextRank(current).includes(rank)) continue;
			const applies = person.hero ? person.hero.assignRanks : rnd.chance(0.6);
			if (!applies) continue;
			const assignedAt = addDays(comp.endDate ?? comp.startDate, rnd.int(30, 120));
			if (assignedAt > DATASET_AS_OF) continue;
			best.set(comp.discipline, rank);
			record.qualifications.push({
				id: rnd.uuid(),
				rank,
				discipline: comp.discipline,
				assignedAt,
				validUntil: validUntil(rank, assignedAt),
				orderNumber: orderNumber(rnd, rank),
				assignedBy: assigningAuthority(rank, person.region),
				basisCompetitionId: comp.id
			});
		}
		// Some ranks predate the platform's history: no known basis competition.
		const primary = person.disciplines[0];
		if (!person.hero && primary && person.birthYear <= 2008 && rnd.chance(0.03)) {
			const rank = rnd.pick<EvskRank>(['II', 'III']);
			const assignedAt = `2023-${String(rnd.int(3, 12)).padStart(2, '0')}-${String(rnd.int(1, 28)).padStart(2, '0')}`;
			const qualification: Qualification = {
				id: rnd.uuid(),
				rank,
				discipline: primary,
				assignedAt,
				validUntil: validUntil(rank, assignedAt),
				orderNumber: orderNumber(rnd, rank),
				assignedBy: assigningAuthority(rank, person.region),
				basisCompetitionId: null
			};
			if (rnd.chance(0.3)) delete qualification.id;
			record.qualifications.push(qualification);
		}
		for (const q of person.hero?.extraQualifications ?? []) record.qualifications.push({ ...q });
	}

	// Platform accounts and the national team.
	for (const person of people) {
		const record = recordOf(person);
		const accounts: PlatformAccount[] = [];
		if (person.hero?.foncodeRating !== undefined) {
			accounts.push({
				platform: 'foncode',
				login: syntheticLogin(rnd, person.name),
				rating: person.hero.foncodeRating
			});
		} else if (!person.hero && person.disciplines.includes('algorithmic') && rnd.chance(0.7)) {
			const rating = Math.round(Math.min(2624, Math.max(800, 1500 + 260 * person.skill + 80 * rnd.normal())));
			accounts.push({ platform: 'foncode', login: syntheticLogin(rnd, person.name), rating });
		}
		if (!person.hero && person.disciplines.includes('infosec') && rnd.chance(0.25)) {
			accounts.push({ platform: 'caplag', login: syntheticLogin(rnd, person.name), rating: null });
		}
		if (accounts.length > 0) record.athlete.platformAccounts = accounts;
		record.athlete.nationalTeam = person.hero?.nationalTeam ?? null;
	}
	for (const discipline of ['algorithmic', 'product', 'uas', 'robotics', 'infosec'] as const) {
		const candidates = people
			.filter(
				(p) => !p.hero && p.disciplines[0] === discipline && p.birthYear <= 2008 && recordOf(p).results.length >= 3
			)
			.sort((a, b) => b.skill - a.skill);
		candidates.slice(0, 20).forEach((p, i) => {
			recordOf(p).athlete.nationalTeam = { discipline, squad: i < 10 ? 'main' : 'reserve', season: 2026 };
		});
	}

	// FSP ID accounts: every athlete, plus accounts without an athlete profile.
	const accounts = new Map<string, Account>();
	const usedLogins = new Set<string>();
	for (const person of people) {
		let login = `${translit(person.name.firstName)}.${translit(person.name.lastName)}`;
		for (let n = 2; usedLogins.has(login); n++)
			login = `${translit(person.name.firstName)}.${translit(person.name.lastName)}${n}`;
		usedLogins.add(login);
		accounts.set(person.fspId, {
			sub: person.fspId,
			email: `${login}@example.com`,
			givenName: person.name.firstName,
			familyName: person.name.lastName,
			preferredUsername: login,
			kind: 'athlete'
		});
	}
	for (const service of SERVICE_ACCOUNTS) accounts.set(service.account.sub, service.account);

	const demo: DemoAccount[] = [
		...HEROES.map((h) => ({ sub: h.fspId, title: h.title, scenario: h.scenario })),
		...SERVICE_ACCOUNTS.map((s) => ({ sub: s.account.sub, title: s.title, scenario: s.scenario }))
	];

	// Hero records sorted like everybody else's: order is defined by the API, not by generation.
	return { datasetId, asOf: DATASET_AS_OF, competitions, athletes: records, accounts, demo };
}
